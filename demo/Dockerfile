FROM node:22-bookworm-slim AS frontend-builder
WORKDIR /frontend
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY frontend ./
RUN pnpm run build

FROM python:3.14-slim AS demo
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 RFG_RESOURCE_PATH=/resource RFG_DATA_DIR=/rfg-data
COPY backend/requirements.txt ./backend/requirements.txt
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backend ./backend
COPY --from=frontend-builder /frontend/dist ./frontend
COPY entrypoint.sh ./entrypoint.sh
RUN chmod 755 ./entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["./entrypoint.sh"]
