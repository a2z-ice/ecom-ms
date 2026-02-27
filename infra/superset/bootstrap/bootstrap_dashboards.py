#!/usr/bin/env python3
"""
Bootstrap Superset dashboards for the Book Store analytics.
Run as a Kubernetes Job after Superset is deployed and the analytics DB has data.

Creates:
  - Database connection to analytics-db
  - Dataset: vw_product_sales_volume
  - Dataset: vw_sales_over_time
  - ECharts bar chart: "Product Sales Volume"
  - ECharts timeseries line chart: "Sales Over Time"
  - Dashboard: "Book Store Analytics" with both charts

NOTE: Superset latest uses ECharts exclusively.
      viz_type "bar"/"line" are removed; use "echarts_bar"/"echarts_timeseries_line".
"""
import json
import os
import sqlite3
import subprocess
import requests

SUPERSET_URL = os.environ.get("SUPERSET_URL", "http://superset.analytics.svc.cluster.local:8088")
SUPERSET_USER = os.environ["SUPERSET_ADMIN_USERNAME"]
SUPERSET_PASS = os.environ["SUPERSET_ADMIN_PASSWORD"]
ANALYTICS_DB_URL = os.environ["ANALYTICS_DB_URL"]
# Path to SQLite DB inside the Superset pod (used for dashboard-slice linking)
SUPERSET_SQLITE = os.environ.get("SUPERSET_SQLITE", "/app/superset_home/superset.db")


def login(session: requests.Session) -> tuple[str, str]:
    """Returns (access_token, csrf_token)."""
    resp = session.post(f"{SUPERSET_URL}/api/v1/security/login", json={
        "username": SUPERSET_USER,
        "password": SUPERSET_PASS,
        "provider": "db",
        "refresh": True,
    })
    resp.raise_for_status()
    token = resp.json()["access_token"]
    csrf_resp = session.get(
        f"{SUPERSET_URL}/api/v1/security/csrf_token/",
        headers={"Authorization": f"Bearer {token}"},
    )
    csrf_resp.raise_for_status()
    csrf_token = csrf_resp.json()["result"]
    return token, csrf_token


def headers(token: str, csrf_token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "X-CSRFToken": csrf_token}


def upsert_database(session: requests.Session, token: str, csrf_token: str) -> int:
    h = headers(token, csrf_token)
    existing = session.get(f"{SUPERSET_URL}/api/v1/database/", headers=h).json()
    for db in existing.get("result", []):
        if db["database_name"] == "Analytics DB":
            return db["id"]
    resp = session.post(f"{SUPERSET_URL}/api/v1/database/", json={
        "database_name": "Analytics DB",
        "sqlalchemy_uri": ANALYTICS_DB_URL,
        "expose_in_sqllab": True,
    }, headers=h)
    resp.raise_for_status()
    return resp.json()["id"]


def upsert_dataset(session: requests.Session, token: str, csrf_token: str,
                   db_id: int, table_name: str) -> int:
    h = headers(token, csrf_token)
    existing = session.get(f"{SUPERSET_URL}/api/v1/dataset/", headers=h).json()
    for ds in existing.get("result", []):
        if ds["table_name"] == table_name:
            return ds["id"]
    resp = session.post(f"{SUPERSET_URL}/api/v1/dataset/", json={
        "database": db_id,
        "table_name": table_name,
        "schema": "public",
    }, headers=h)
    resp.raise_for_status()
    return resp.json()["id"]


def metric(col_name: str, col_type: str = "DOUBLE PRECISION") -> dict:
    """Build a simple SUM metric object for Superset chart params."""
    return {
        "expressionType": "SIMPLE",
        "column": {"column_name": col_name, "type": col_type},
        "aggregate": "SUM",
        "label": col_name,
    }


def upsert_chart(session: requests.Session, token: str, csrf_token: str,
                 name: str, viz_type: str, dataset_id: int, params: dict) -> int:
    h = headers(token, csrf_token)
    existing = session.get(f"{SUPERSET_URL}/api/v1/chart/", headers=h).json()
    for c in existing.get("result", []):
        if c["slice_name"] == name:
            # Update in place
            session.put(f"{SUPERSET_URL}/api/v1/chart/{c['id']}", json={
                "viz_type": viz_type,
                "datasource_id": dataset_id,
                "params": json.dumps(params),
            }, headers=h)
            return c["id"]
    resp = session.post(f"{SUPERSET_URL}/api/v1/chart/", json={
        "slice_name": name,
        "viz_type": viz_type,
        "datasource_id": dataset_id,
        "datasource_type": "table",
        "params": json.dumps(params),
    }, headers=h)
    resp.raise_for_status()
    return resp.json()["id"]


def upsert_dashboard(session: requests.Session, token: str, csrf_token: str,
                     chart_ids: list[int]) -> int:
    h = headers(token, csrf_token)
    existing = session.get(f"{SUPERSET_URL}/api/v1/dashboard/", headers=h).json()
    dash_id = None
    for d in existing.get("result", []):
        if d["dashboard_title"] == "Book Store Analytics":
            dash_id = d["id"]
            break

    position_json = json.dumps({
        "DASHBOARD_VERSION_KEY": "v2",
        "GRID_ID": {"children": ["ROW-1"], "id": "GRID_ID", "parents": ["ROOT_ID"], "type": "GRID"},
        "ROOT_ID": {"children": ["GRID_ID"], "id": "ROOT_ID", "type": "ROOT"},
        "ROW-1": {
            "children": [f"CHART-{cid}" for cid in chart_ids],
            "id": "ROW-1",
            "meta": {"background": "BACKGROUND_TRANSPARENT"},
            "parents": ["ROOT_ID", "GRID_ID"],
            "type": "ROW",
        },
        **{
            f"CHART-{cid}": {
                "children": [],
                "id": f"CHART-{cid}",
                "meta": {"chartId": cid, "height": 50, "width": 6},
                "parents": ["ROOT_ID", "GRID_ID", "ROW-1"],
                "type": "CHART",
            }
            for cid in chart_ids
        },
    })

    if dash_id is None:
        resp = session.post(f"{SUPERSET_URL}/api/v1/dashboard/", json={
            "dashboard_title": "Book Store Analytics",
            "published": True,
            "position_json": position_json,
        }, headers=h)
        resp.raise_for_status()
        dash_id = resp.json()["id"]
    else:
        session.put(f"{SUPERSET_URL}/api/v1/dashboard/{dash_id}", json={
            "position_json": position_json,
        }, headers=h)

    # Link charts to dashboard via SQLite (the REST API does not support this directly)
    _link_charts_sqlite(dash_id, chart_ids)
    return dash_id


def _link_charts_sqlite(dash_id: int, chart_ids: list[int]) -> None:
    """Directly update the SQLite M2M table to link charts to the dashboard."""
    conn = sqlite3.connect(SUPERSET_SQLITE)
    c = conn.cursor()
    c.execute("DELETE FROM dashboard_slices WHERE dashboard_id=?", (dash_id,))
    for chart_id in chart_ids:
        c.execute("INSERT INTO dashboard_slices (dashboard_id, slice_id) VALUES (?, ?)",
                  (dash_id, chart_id))
    conn.commit()
    conn.close()
    print(f"  Linked charts {chart_ids} to dashboard {dash_id}")


def main() -> None:
    session = requests.Session()
    print("Logging in to Superset...")
    token, csrf_token = login(session)

    print("Creating analytics DB connection...")
    db_id = upsert_database(session, token, csrf_token)
    print(f"  DB id={db_id}")

    print("Creating datasets...")
    sales_vol_ds = upsert_dataset(session, token, csrf_token, db_id, "vw_product_sales_volume")
    sales_time_ds = upsert_dataset(session, token, csrf_token, db_id, "vw_sales_over_time")
    print(f"  vw_product_sales_volume id={sales_vol_ds}")
    print(f"  vw_sales_over_time id={sales_time_ds}")

    print("Creating ECharts bar chart: Product Sales Volume...")
    bar_chart_id = upsert_chart(
        session, token, csrf_token,
        "Product Sales Volume",
        "echarts_bar",
        sales_vol_ds,
        {
            "metrics": [metric("units_sold", "BIGINT")],
            "groupby": ["title"],
            "x_axis": "title",
            "row_limit": 20,
            "color_scheme": "supersetColors",
        },
    )

    print("Creating ECharts line chart: Sales Over Time...")
    line_chart_id = upsert_chart(
        session, token, csrf_token,
        "Sales Over Time",
        "echarts_timeseries_line",
        sales_time_ds,
        {
            "metrics": [metric("daily_revenue")],
            "groupby": [],
            "x_axis": "sale_date",
            "row_limit": 365,
            "color_scheme": "supersetColors",
        },
    )

    print("Creating dashboard...")
    dash_id = upsert_dashboard(session, token, csrf_token, [bar_chart_id, line_chart_id])

    print("✔ Superset bootstrap complete.")
    print(f"  Dashboard: Book Store Analytics (id={dash_id})")
    print(f"  URL: {SUPERSET_URL}/superset/dashboard/{dash_id}/")


if __name__ == "__main__":
    main()
