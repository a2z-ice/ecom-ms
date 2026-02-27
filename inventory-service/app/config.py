from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    keycloak_jwks_uri: str
    keycloak_issuer_uri: str
    kafka_bootstrap_servers: str
    kafka_group_id: str = "inventory-service"

    class Config:
        env_file = ".env"
        case_sensitive = False


settings = Settings()
