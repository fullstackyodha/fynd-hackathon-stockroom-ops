from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://reservations:reservations@localhost:5434/reservations"
    cors_origins: str = "http://localhost:5173"
    database_pool_size: int = Field(default=10, gt=0)
    database_max_overflow: int = Field(default=20, ge=0)
    database_pool_timeout_seconds: int = Field(default=5, gt=0)

    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


settings = Settings()
