FROM python:3.12-slim

WORKDIR /app
RUN pip install --no-cache-dir uv==0.11.7
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY alembic.ini .
COPY migrations ./migrations
COPY app ./app
RUN uv sync --locked --no-dev
ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
