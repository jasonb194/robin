FROM node:22-alpine AS build
WORKDIR /app
COPY controller/package*.json ./
RUN npm ci
COPY controller/tsconfig.json ./
COPY controller/src ./src
COPY templates/robin.yml ./templates/robin.yml
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY controller/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/templates ./templates
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
