jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import * as http from "http";
import { AddressInfo } from "net";
import { inspect } from "node:util";
import * as core from "@actions/core";
import { LLMClient } from "./llm-client";

/**
 * Real local HTTP regressions for the max-output-tokens compatibility contract.
 *
 * These deliberately use a real socket and the real OpenAI SDK: the failure being
 * guarded against is the *emitted body* losing a configured cap (by being renamed or
 * omitted), which a `create()` stub cannot observe. The gateway is request-driven — it
 * decides its response from the request body — rather than a fixed success/failure queue.
 */

type Body = Record<string, unknown>;

interface Gateway {
  baseUrl: string;
  requests: Body[];
  requestHeaders: Record<string, string | string[] | undefined>[];
  close: () => Promise<void>;
}

interface GatewayResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function startGateway(handler: (body: Body) => GatewayResponse): Promise<Gateway> {
  const requests: Body[] = [];
  const requestHeaders: Record<string, string | string[] | undefined>[] = [];
  const server = http.createServer((req, res) => {
    requestHeaders.push(req.headers);
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      requests.push(parsed);
      const { status, body, headers = {} } = handler(parsed);
      res.writeHead(status, {
        "content-type": typeof body === "string" ? "text/plain" : "application/json",
        ...headers,
      });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        requestHeaders,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function listen(server: http.Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address() as AddressInfo));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function completion(model: string, content = "review text") {
  return {
    status: 200,
    body: {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  };
}

function unsupportedField(param: string, hint: string) {
  return {
    status: 400,
    body: {
      error: {
        message: `Unsupported parameter: '${param}' is not supported with this model. ${hint}`,
        type: "invalid_request_error",
        param,
        code: "unsupported_parameter",
      },
    },
  };
}

function makeClient(baseUrl: string, model: string, maxOutputTokens: number): LLMClient {
  // maxAttempts:1 isolates the in-request parameter fallback from the outer retry loop.
  return new LLMClient(baseUrl, "test-key", model, maxOutputTokens, undefined, 1);
}

const hasAnyTokenField = (body: Body) =>
  body.max_tokens !== undefined || body.max_completion_tokens !== undefined;

function debugOutput(debugLog: jest.SpyInstance): string {
  return debugLog.mock.calls
    .map((args: unknown[]) => args.map((arg) => inspect(arg, { depth: null })).join(" "))
    .join("\n");
}

describe("max-output-tokens compatibility (real local endpoint)", () => {
  it("sends Cloudflare Access service-token headers on LLM requests", async () => {
    const gateway = await startGateway(() => completion("test-model"));
    const originalDebug = process.env.DEBUG;
    process.env.DEBUG = "true";
    const debugLog = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      jest.clearAllMocks();
      const client = new LLMClient(
        gateway.baseUrl,
        "test-key",
        "test-model",
        undefined,
        undefined,
        1,
        undefined,
        undefined,
        undefined,
        "cf-client-id",
        "cf-client-secret"
      );
      await client.chatCompletion("system", "user");
      await client.chatWithTools([
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ], []);

      expect(gateway.requestHeaders).toHaveLength(2);
      for (const headers of gateway.requestHeaders) {
        expect(headers["cf-access-client-id"]).toBe("cf-client-id");
        expect(headers["cf-access-client-secret"]).toBe("cf-client-secret");
      }
      expect(debugOutput(debugLog)).not.toContain("cf-client-secret");
    } finally {
      debugLog.mockRestore();
      if (originalDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = originalDebug;
      await gateway.close();
    }
  });

  it("does not forward Cloudflare Access headers across a redirect", async () => {
    const targetHeaders: Record<string, string | string[] | undefined>[] = [];
    const target = http.createServer((req, res) => {
      targetHeaders.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completion("test-model").body));
    });
    const targetAddress = await listen(target);
    const targetUrl = `http://127.0.0.1:${targetAddress.port}/v1/chat/completions`;
    const redirect = http.createServer((_req, res) => {
      res.writeHead(307, { location: targetUrl });
      res.end();
    });
    const redirectAddress = await listen(redirect);

    try {
      const client = new LLMClient(
        `http://127.0.0.1:${redirectAddress.port}/v1`,
        "test-key",
        "test-model",
        undefined,
        undefined,
        1,
        undefined,
        undefined,
        undefined,
        "cf-client-id",
        "cf-client-secret"
      );
      await expect(client.chatCompletion("system", "user")).rejects.toThrow(
        "Failed to get response from LLM"
      );
      expect(targetHeaders).toHaveLength(0);
    } finally {
      await Promise.all([close(redirect), close(target)]);
    }
  });

  it("sends Cloudflare Access headers while consuming a successful SSE stream without buffering", async () => {
    const requestHeaders: Record<string, string | string[] | undefined>[] = [];
    let releaseResponse: () => void = () => {};
    let signalFirstChunk: () => void = () => {};
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const firstChunkProgress = new Promise<void>((resolve) => {
      signalFirstChunk = resolve;
    });
    const server = http.createServer((req, res) => {
      requestHeaders.push(req.headers);
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-chunk-1",
          object: "chat.completion.chunk",
          created: 0,
          model: "routed-model",
          choices: [{ index: 0, delta: { content: "streamed " }, finish_reason: null }],
        })}\n\n`
      );
      void responseGate.then(() => {
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-chunk-2",
            object: "chat.completion.chunk",
            created: 0,
            model: "routed-model",
            choices: [{ index: 0, delta: { content: "review" }, finish_reason: null }],
          })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-chunk-3",
            object: "chat.completion.chunk",
            created: 0,
            model: "routed-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`
        );
        res.end("data: [DONE]\n\n");
      });
    });
    const address = await listen(server);
    let sawFirstChunk = false;

    try {
      const client = new LLMClient(
        `http://127.0.0.1:${address.port}/v1`,
        "test-key",
        "openrouter/free",
        undefined,
        10000,
        1,
        undefined,
        (detail) => {
          if (detail.includes("generating review")) {
            sawFirstChunk = true;
            signalFirstChunk();
            releaseResponse();
          }
        },
        undefined,
        "cf-client-id",
        "cf-client-secret"
      );

      const request = client.chatCompletion("system", "user");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const firstChunkWithinTimeout = await Promise.race([
        firstChunkProgress.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 5000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!firstChunkWithinTimeout) releaseResponse();

      const result = await request;
      expect(firstChunkWithinTimeout).toBe(true);
      expect(sawFirstChunk).toBe(true);
      expect(result.content).toBe("streamed review");
      expect(requestHeaders).toHaveLength(1);
      expect(requestHeaders[0]["cf-access-client-id"]).toBe("cf-client-id");
      expect(requestHeaders[0]["cf-access-client-secret"]).toBe("cf-client-secret");
    } finally {
      releaseResponse();
      await close(server);
    }
  }, 15000);

  it("redacts an echoed client ID split across malformed SSE chunks before SDK error logs", async () => {
    const clientId = "cf-client-id";
    const secret = "cf-client-secret";
    const requestHeaders: Record<string, string | string[] | undefined>[] = [];
    const server = http.createServer((req, res) => {
      requestHeaders.push(req.headers);
      req.resume();
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-echoed-access-token": `${clientId} ${secret}`,
      });
      const splitAt = 7;
      res.write(`data: Access token rejected: ${clientId.slice(0, splitAt)}`);
      setTimeout(() => res.end(`${clientId.slice(splitAt)} ${secret}\n\n`), 10);
    });
    const address = await listen(server);
    const originalDebug = process.env.DEBUG;
    process.env.DEBUG = "true";
    const debugLog = jest.spyOn(console, "log").mockImplementation(() => {});
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const client = new LLMClient(
        `http://127.0.0.1:${address.port}/v1`,
        "test-key",
        "openrouter/free",
        undefined,
        5000,
        1,
        undefined,
        undefined,
        undefined,
        clientId,
        secret
      );
      const error = await client.chatCompletion("system", "user").then(
        () => {
          throw new Error("Expected the malformed SSE event to fail");
        },
        (reason: unknown) => reason as Error
      );
      const debugLogs = debugOutput(debugLog);
      const parserErrors = debugOutput(errorLog);

      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain(clientId);
      expect(requestHeaders).toHaveLength(1);
      expect(requestHeaders[0]["cf-access-client-secret"]).toBe(secret);
      expect(debugLogs).toContain("[REDACTED]");
      expect(debugLogs).not.toContain(secret);
      expect(debugLogs).not.toContain(clientId);
      expect(parserErrors).toContain("[REDACTED]");
      expect(parserErrors).not.toContain(secret);
      expect(parserErrors).not.toContain(clientId);
    } finally {
      debugLog.mockRestore();
      errorLog.mockRestore();
      if (originalDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = originalDebug;
      await close(server);
    }
  });

  it("redacts a self-overlapping credential when a network chunk ends after its full value", async () => {
    const clientId = "abab";
    const secret = "ababa";
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      // The boundary is exactly after a full credential. Its final `ab` is also a
      // possible beginning of another occurrence, so the scanner must retain it hidden.
      res.write(`data: {"broken":"${clientId}`);
      setTimeout(() => res.end('a"x"}\n\n'), 10);
    });
    const address = await listen(server);
    const originalDebug = process.env.DEBUG;
    process.env.DEBUG = "true";
    const debugLog = jest.spyOn(console, "log").mockImplementation(() => {});
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const client = new LLMClient(
        `http://127.0.0.1:${address.port}/v1`,
        "test-key",
        "openrouter/free",
        undefined,
        5000,
        1,
        undefined,
        undefined,
        undefined,
        clientId,
        secret
      );
      const error = await client.chatCompletion("system", "user").then(
        () => { throw new Error("Expected the malformed SSE event to fail"); },
        (reason: unknown) => reason as Error
      );
      const logs = `${debugOutput(debugLog)}\n${debugOutput(errorLog)}`;

      expect(error.message).not.toContain(clientId);
      expect(error.message).not.toContain(secret);
      expect(logs).toContain("[REDACTED]");
      expect(logs).not.toContain(clientId);
      expect(logs).not.toContain(secret);
    } finally {
      debugLog.mockRestore();
      errorLog.mockRestore();
      if (originalDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = originalDebug;
      await close(server);
    }
  });

  it("redacts an echoed Cloudflare Access secret from LLM errors and logs", async () => {
    const clientId = "cf-client-id";
    const secret = "cf-client-secret";
    const gateway = await startGateway(() => ({
      status: 401,
      body: { error: { message: `Access token rejected: ${clientId} ${secret}` } },
    }));
    try {
      jest.clearAllMocks();
      const client = new LLMClient(
        gateway.baseUrl,
        "test-key",
        "test-model",
        undefined,
        undefined,
        1,
        undefined,
        undefined,
        undefined,
        clientId,
        secret
      );
      const error = await client.chatCompletion("system", "user").then(
        () => {
          throw new Error("Expected the rejected LLM request to throw");
        },
        (reason: unknown) => reason as Error
      );

      expect(error.message).toContain("[REDACTED]");
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain(clientId);
      const logs = [
        ...(core.warning as jest.Mock).mock.calls,
        ...(core.error as jest.Mock).mock.calls,
      ].flat().join(" ");
      expect(logs).not.toContain(secret);
      expect(logs).not.toContain(clientId);
    } finally {
      await gateway.close();
    }
  });

  it("redacts echoed secrets from SDK debug response values, keys, and headers", async () => {
    const clientId = "cf-client-id";
    const secret = "cf-client-secret";
    const response = completion("test-model", `Provider echoed ${clientId} ${secret}`);
    const responseBody = response.body as unknown as {
      choices: Array<{ message: Record<string, unknown> }>;
    };
    responseBody.choices[0].message[clientId] = "echoed client ID property";
    responseBody.choices[0].message[secret] = "earlier colliding property";
    responseBody.choices[0].message["[REDACTED]"] = "later colliding property";
    const gateway = await startGateway(() => ({
      ...response,
      headers: {
        "x-echoed-access-token": `${clientId} ${secret}`,
        [secret]: "echoed in header name",
        [clientId]: "echoed client ID header name",
      },
    }));
    const originalDebug = process.env.DEBUG;
    process.env.DEBUG = "true";
    const debugLog = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const client = new LLMClient(
        gateway.baseUrl,
        "test-key",
        "test-model",
        undefined,
        undefined,
        1,
        undefined,
        undefined,
        undefined,
        "cf-client-id",
        secret
      );
      const result = await client.chatCompletion("system", "user");
      const logs = debugOutput(debugLog);

      expect(result.content).toBe("Provider echoed [REDACTED] [REDACTED]");
      expect(logs).toContain("x-echoed-access-token");
      expect(logs).toContain("x-robin-redacted-header-0");
      expect(logs).toContain("[REDACTED]");
      expect(logs).toContain("later colliding property");
      expect(logs).not.toContain("earlier colliding property");
      expect(logs).not.toContain(secret);
      expect(logs).not.toContain(clientId);
    } finally {
      debugLog.mockRestore();
      if (originalDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = originalDebug;
      await gateway.close();
    }
  });

  it("redacts echoed secrets from SDK debug output for non-JSON error bodies", async () => {
    const clientId = "cf-client-id";
    const secret = "cf-client-secret";
    const gateway = await startGateway(() => ({
      status: 401,
      body: `Access token rejected: ${clientId} ${secret}`,
      headers: { "x-echoed-access-token": `${clientId} ${secret}` },
    }));
    const originalDebug = process.env.DEBUG;
    process.env.DEBUG = "true";
    const debugLog = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      const client = new LLMClient(
        gateway.baseUrl,
        "test-key",
        "test-model",
        undefined,
        undefined,
        1,
        undefined,
        undefined,
        undefined,
        clientId,
        secret
      );
      const error = await client.chatCompletion("system", "user").then(
        () => {
          throw new Error("Expected the rejected LLM request to throw");
        },
        (reason: unknown) => reason as Error
      );
      const logs = debugOutput(debugLog);

      expect(error.message).toContain("[REDACTED]");
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain(clientId);
      expect(logs).toContain("[REDACTED]");
      expect(logs).not.toContain(secret);
      expect(logs).not.toContain(clientId);
    } finally {
      debugLog.mockRestore();
      if (originalDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = originalDebug;
      await gateway.close();
    }
  });

  it("keeps the cap by switching to max_tokens on a max_tokens-only gateway (reasoning-family name)", async () => {
    const gateway = await startGateway((body) =>
      body.max_completion_tokens !== undefined
        ? unsupportedField("max_completion_tokens", "Use 'max_tokens' instead.")
        : completion("gpt-5"),
    );
    try {
      const client = makeClient(gateway.baseUrl, "gpt-5", 1234);
      const result = await client.chatCompletion("system", "user");

      expect(result.content).toBe("review text");
      expect(gateway.requests).toHaveLength(2);
      expect(gateway.requests[0]).toHaveProperty("max_completion_tokens", 1234);
      expect(gateway.requests[1]).not.toHaveProperty("max_completion_tokens");
      expect(gateway.requests[1]).toHaveProperty("max_tokens", 1234);
      expect(gateway.requests.every(hasAnyTokenField)).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("keeps the cap by switching to max_completion_tokens on a max_completion_tokens-only gateway", async () => {
    const gateway = await startGateway((body) =>
      body.max_tokens !== undefined
        ? unsupportedField("max_tokens", "Use 'max_completion_tokens' instead.")
        : completion("gpt-4o"),
    );
    try {
      const client = makeClient(gateway.baseUrl, "gpt-4o", 1234);
      const result = await client.chatCompletion("system", "user");

      expect(result.content).toBe("review text");
      expect(gateway.requests).toHaveLength(2);
      expect(gateway.requests[0]).toHaveProperty("max_tokens", 1234);
      expect(gateway.requests[1]).not.toHaveProperty("max_tokens");
      expect(gateway.requests[1]).toHaveProperty("max_completion_tokens", 1234);
      expect(gateway.requests.every(hasAnyTokenField)).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("keeps the adjusted cap for later chatCompletion and chatWithTools turns in the same run", async () => {
    const gateway = await startGateway((body) =>
      body.max_completion_tokens !== undefined
        ? unsupportedField("max_completion_tokens", "Use 'max_tokens' instead.")
        : completion("gpt-5"),
    );
    try {
      const client = makeClient(gateway.baseUrl, "gpt-5", 1234);
      await client.chatCompletion("system", "first");
      await client.chatCompletion("system", "second");
      await client.chatWithTools(
        [
          { role: "system", content: "system" },
          { role: "user", content: "user" },
        ],
        [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      );

      // Exactly one request needed the incompatible field; every later turn keeps max_tokens.
      expect(gateway.requests.filter((body) => body.max_completion_tokens !== undefined)).toHaveLength(1);
      const last = gateway.requests[gateway.requests.length - 1];
      expect(last).toHaveProperty("max_tokens", 1234);
      expect(last).not.toHaveProperty("max_completion_tokens");
      expect(gateway.requests.slice(1).every(hasAnyTokenField)).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("surfaces the provider error and never sends an uncapped request when both token fields are rejected", async () => {
    const gateway = await startGateway((body) =>
      unsupportedField(
        body.max_tokens !== undefined ? "max_tokens" : "max_completion_tokens",
        "No output-token cap is supported.",
      ),
    );
    try {
      const client = makeClient(gateway.baseUrl, "gpt-5", 3000);

      await expect(client.chatCompletion("system", "user")).rejects.toThrow(
        /Failed to get response from LLM/,
      );
      expect(gateway.requests.length).toBeLessThanOrEqual(2);
      expect(gateway.requests.every(hasAnyTokenField)).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it.each([
    ["gpt-5", "max_completion_tokens", 400],
    ["gpt-5", "max_completion_tokens", 422],
    ["gpt-4o", "max_tokens", 400],
    ["gpt-4o", "max_tokens", 422],
  ])(
    "surfaces an invalid token-limit value for %s (%s, HTTP %i) without dropping the cap",
    async (model, field, status) => {
      const gateway = await startGateway((body) => {
        const value = body[field] as number | undefined;
        if (value !== undefined && value < 16) {
          return {
            status,
            body: {
              error: {
                message: `Invalid value for '${field}': Expected a value >= 16, but got ${value} instead.`,
                type: "invalid_request_error",
                param: field,
                code: "integer_below_min_value",
              },
            },
          };
        }
        return completion(model);
      });
      try {
        const client = makeClient(gateway.baseUrl, model, 8);

        await expect(client.chatCompletion("system", "user")).rejects.toThrow(
          /Invalid value for/,
        );
        expect(gateway.requests).toHaveLength(1);
        expect(gateway.requests[0]).toHaveProperty(field, 8);
        expect(hasAnyTokenField(gateway.requests[0])).toBe(true);
      } finally {
        await gateway.close();
      }
    },
  );

  it("surfaces an unsupported_value token-limit error without swapping fields or dropping the cap", async () => {
    // Both field spellings are accepted, but values below 16 are invalid. The structured value
    // error must surface after exactly one capped request instead of trying the other spelling.
    const gateway = await startGateway((body) => {
      const field = body.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens";
      const value = body[field] as number | undefined;
      if (value !== undefined && value < 16) {
        return {
          status: 400,
          body: {
            error: {
              message: `Unsupported value for ${field}: must be at least 16, but got ${value}.`,
              type: "invalid_request_error",
              param: field,
              code: "unsupported_value",
            },
          },
        };
      }
      return completion("gpt-5");
    });
    try {
      const client = makeClient(gateway.baseUrl, "gpt-5", 1);

      await expect(client.chatCompletion("system", "user")).rejects.toThrow(
        /Unsupported value for/,
      );
      expect(gateway.requests).toHaveLength(1);
      expect(gateway.requests[0]).toHaveProperty("max_completion_tokens", 1);
      expect(gateway.requests[0]).not.toHaveProperty("max_tokens");
    } finally {
      await gateway.close();
    }
  });
});
