# MCP サーバ（AgentCore Runtime 用、ARM64）。ビルドコンテキストはリポジトリルート。
# 事前に `npm run build` で dist/mcp/main.js（esbuild 単一ファイル）を生成しておく。
# ARM64 イメージのビルドはデプロイ時に CodeBuild が行う（ADR-0005）。
FROM public.ecr.aws/docker/library/node:22-slim
ENV NODE_ENV=production PORT=8000
WORKDIR /app
COPY dist/mcp/main.js ./main.js
EXPOSE 8000
USER node
CMD ["node", "main.js"]
