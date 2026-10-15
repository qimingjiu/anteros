# Immutable base manifest, checked against the official Python registry on 2026-10-15.
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1 AS base
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
RUN useradd --create-home --uid 10001 research

FROM base AS gateway
COPY requirements-gateway.txt constraints.txt ./
RUN python -m pip install --no-cache-dir -c constraints.txt -r requirements-gateway.txt
COPY policy.py gateway.py ./
USER 10001:10001
EXPOSE 8790
CMD ["python", "gateway.py"]

FROM mcr.microsoft.com/playwright/python:v1.63.0-noble@sha256:72bd171a9ffc2b4b59532aaa6210e21014d07093120dc25528870c0b840da1f0 AS sidecar
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_BREAK_SYSTEM_PACKAGES=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright CRAWL4AI_TELEMETRY_ENABLED=false HOME=/home/research
WORKDIR /app
RUN useradd --create-home --uid 10001 research
COPY requirements.txt constraints.txt ./
RUN python -m pip install --no-cache-dir -c constraints.txt -r requirements.txt
COPY policy.py service.py worker.py smoke_probe.py ./
USER 10001:10001
EXPOSE 8787
CMD ["python", "service.py"]
