#!/usr/bin/env python3
"""
Bootstrap Superset dashboards for the Book Store analytics.
Run as a Kubernetes Job after Superset is deployed and the analytics DB has data.

Creates:
  - Database connection to analytics-db
  - 10 Datasets (2 existing + 8 new analytics views)
  - 14 Charts (2 existing + 12 new)
  - 3 Dashboards:
      "Book Store Analytics"      — 5 charts (product sales + time trend + author/genre/price)
      "Sales & Revenue Analytics" — 5 charts (KPIs + order status + avg order value over time)
      "Inventory Analytics"       — 4 charts (health table + stock/reserved + turnover + genre)

NOTE: Confirmed working viz types in apache/superset:latest:
      - "echarts_timeseries_bar"  (bar charts — NOT "echarts_bar", not registered)
      - "echarts_timeseries_line" (line/time-series charts)
      - "pie"                     (pie charts — NOT "echarts_pie", not registered)
      - "table"                   (table/grid)
      - "big_number_total"        (KPI big numbers)
"""
import json
import os
import sqlite3
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


def metric(col_name: str, col_type: str = "DOUBLE PRECISION", agg: str = "SUM") -> dict:
    """Build a simple aggregation metric object for Superset chart params."""
    return {
        "expressionType": "SIMPLE",
        "column": {"column_name": col_name, "type": col_type},
        "aggregate": agg,
        "label": f"{agg}({col_name})",
    }


def upsert_chart(session: requests.Session, token: str, csrf_token: str,
                 name: str, viz_type: str, dataset_id: int, params: dict) -> int:
    h = headers(token, csrf_token)
    existing = session.get(f"{SUPERSET_URL}/api/v1/chart/", headers=h).json()
    for c in existing.get("result", []):
        if c["slice_name"] == name:
            # Update in place — include datasource_type to avoid 400
            r = session.put(f"{SUPERSET_URL}/api/v1/chart/{c['id']}", json={
                "viz_type": viz_type,
                "datasource_id": dataset_id,
                "datasource_type": "table",
                "params": json.dumps(params),
            }, headers=h)
            if not r.ok:
                print(f"  WARN: PUT chart {c['id']} ({name}) returned {r.status_code}: {r.text[:100]}")
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
                     title: str, chart_ids: list[int]) -> int:
    h = headers(token, csrf_token)
    existing = session.get(f"{SUPERSET_URL}/api/v1/dashboard/", headers=h).json()
    dash_id = None
    for d in existing.get("result", []):
        if d["dashboard_title"] == title:
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
            "dashboard_title": title,
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

    # ─── Datasets ───────────────────────────────────────────────────────────
    print("Creating datasets...")
    ds = {}
    for view in [
        "vw_product_sales_volume",
        "vw_sales_over_time",
        "vw_revenue_by_author",
        "vw_revenue_by_genre",
        "vw_order_status_distribution",
        "vw_inventory_health",
        "vw_avg_order_value",
        "vw_top_books_by_revenue",
        "vw_inventory_turnover",
        "vw_book_price_distribution",
    ]:
        ds[view] = upsert_dataset(session, token, csrf_token, db_id, view)
        print(f"  {view} id={ds[view]}")

    # ─── Charts ─────────────────────────────────────────────────────────────
    print("Creating charts...")

    # ── Dashboard 1: Book Store Analytics ───────────────────────────────────
    bar_chart_id = upsert_chart(
        session, token, csrf_token,
        "Product Sales Volume", "echarts_timeseries_bar",
        ds["vw_product_sales_volume"],
        {
            "metrics": [metric("units_sold", "BIGINT")],
            "groupby": [],
            "x_axis": "title",
            "row_limit": 20,
            "color_scheme": "supersetColors",
        },
    )
    print(f"  Product Sales Volume id={bar_chart_id}")

    line_chart_id = upsert_chart(
        session, token, csrf_token,
        "Sales Over Time", "echarts_timeseries_line",
        ds["vw_sales_over_time"],
        {
            "metrics": [metric("daily_revenue")],
            "groupby": [],
            "x_axis": "sale_date",
            "row_limit": 365,
            "color_scheme": "supersetColors",
        },
    )
    print(f"  Sales Over Time id={line_chart_id}")

    revenue_by_author_id = upsert_chart(
        session, token, csrf_token,
        "Revenue by Author", "echarts_timeseries_bar",
        ds["vw_revenue_by_author"],
        {
            "metrics": [metric("revenue")],
            "groupby": [],
            "x_axis": "author",
            "row_limit": 20,
            "color_scheme": "supersetColors",
        },
    )
    print(f"  Revenue by Author id={revenue_by_author_id}")

    top_books_id = upsert_chart(
        session, token, csrf_token,
        "Top Books by Revenue", "echarts_timeseries_bar",
        ds["vw_top_books_by_revenue"],
        {
            "metrics": [metric("total_revenue")],
            "groupby": [],
            "x_axis": "title",
            "row_limit": 10,
            "color_scheme": "supersetColors",
        },
    )
    print(f"  Top Books by Revenue id={top_books_id}")

    price_dist_id = upsert_chart(
        session, token, csrf_token,
        "Book Price Distribution", "pie",
        ds["vw_book_price_distribution"],
        {
            "metric": metric("book_count", "BIGINT", "SUM"),
            "groupby": ["price_range"],
            "row_limit": 10,
            "color_scheme": "supersetColors",
            "show_labels": True,
        },
    )
    print(f"  Book Price Distribution id={price_dist_id}")

    # ── Dashboard 2: Sales & Revenue Analytics ───────────────────────────────
    total_revenue_kpi_id = upsert_chart(
        session, token, csrf_token,
        "Total Revenue KPI", "big_number_total",
        ds["vw_sales_over_time"],
        {
            "metric": metric("daily_revenue"),
            "subheader": "Total Revenue (All Time)",
            "y_axis_format": "$,.2f",
        },
    )
    print(f"  Total Revenue KPI id={total_revenue_kpi_id}")

    total_orders_kpi_id = upsert_chart(
        session, token, csrf_token,
        "Total Orders KPI", "big_number_total",
        ds["vw_avg_order_value"],
        {
            "metric": metric("order_count", "BIGINT"),
            "subheader": "Total Orders (All Time)",
            "y_axis_format": ",d",
        },
    )
    print(f"  Total Orders KPI id={total_orders_kpi_id}")

    avg_order_kpi_id = upsert_chart(
        session, token, csrf_token,
        "Average Order Value KPI", "big_number_total",
        ds["vw_avg_order_value"],
        {
            "metric": metric("avg_order_value", "DOUBLE PRECISION", "AVG"),
            "subheader": "Avg Order Value",
            "y_axis_format": "$,.2f",
        },
    )
    print(f"  Average Order Value KPI id={avg_order_kpi_id}")

    order_status_id = upsert_chart(
        session, token, csrf_token,
        "Order Status Distribution", "pie",
        ds["vw_order_status_distribution"],
        {
            "metric": metric("order_count", "BIGINT"),
            "groupby": ["status"],
            "row_limit": 10,
            "color_scheme": "supersetColors",
            "show_labels": True,
        },
    )
    print(f"  Order Status Distribution id={order_status_id}")

    avg_order_time_id = upsert_chart(
        session, token, csrf_token,
        "Avg Order Value Over Time", "echarts_timeseries_line",
        ds["vw_avg_order_value"],
        {
            "metrics": [metric("avg_order_value")],
            "groupby": [],
            "x_axis": "sale_date",
            "row_limit": 365,
            "color_scheme": "supersetColors",
        },
    )
    print(f"  Avg Order Value Over Time id={avg_order_time_id}")

    # ── Dashboard 3: Inventory Analytics ────────────────────────────────────
    inv_health_table_id = upsert_chart(
        session, token, csrf_token,
        "Inventory Health Table", "table",
        ds["vw_inventory_health"],
        {
            "all_columns": ["title", "author", "stock_quantity", "reserved", "available", "stock_status"],
            "row_limit": 50,
            "table_timestamp_format": "%Y-%m-%d",
        },
    )
    print(f"  Inventory Health Table id={inv_health_table_id}")

    stock_vs_reserved_id = upsert_chart(
        session, token, csrf_token,
        "Stock vs Reserved", "echarts_timeseries_bar",
        ds["vw_inventory_health"],
        {
            "metrics": [
                metric("stock_quantity", "INTEGER"),
                metric("reserved", "INTEGER"),
            ],
            "groupby": [],
            "x_axis": "title",
            "row_limit": 20,
            "color_scheme": "supersetColors",
        },
    )
    print(f"  Stock vs Reserved id={stock_vs_reserved_id}")

    inv_turnover_id = upsert_chart(
        session, token, csrf_token,
        "Inventory Turnover Rate", "echarts_timeseries_bar",
        ds["vw_inventory_turnover"],
        {
            "metrics": [metric("turnover_rate_pct", "DOUBLE PRECISION")],
            "groupby": [],
            "x_axis": "title",
            "row_limit": 20,
            "color_scheme": "supersetColors",
        },
    )
    print(f"  Inventory Turnover Rate id={inv_turnover_id}")

    revenue_by_genre_id = upsert_chart(
        session, token, csrf_token,
        "Revenue by Genre", "echarts_timeseries_bar",
        ds["vw_revenue_by_genre"],
        {
            "metrics": [metric("revenue")],
            "groupby": [],
            "x_axis": "genre",
            "row_limit": 20,
            "color_scheme": "supersetColors",
        },
    )
    print(f"  Revenue by Genre id={revenue_by_genre_id}")

    # New pie chart: stock status distribution (Critical / Low / OK)
    stock_status_pie_id = upsert_chart(
        session, token, csrf_token,
        "Stock Status Distribution", "pie",
        ds["vw_inventory_health"],
        {
            "metric": metric("title", "VARCHAR", "COUNT"),
            "groupby": ["stock_status"],
            "row_limit": 10,
            "color_scheme": "supersetColors",
            "show_labels": True,
            "show_legend": True,
        },
    )
    print(f"  Stock Status Distribution id={stock_status_pie_id}")

    # New pie chart: revenue share by genre
    genre_revenue_pie_id = upsert_chart(
        session, token, csrf_token,
        "Revenue Share by Genre", "pie",
        ds["vw_revenue_by_genre"],
        {
            "metric": metric("revenue"),
            "groupby": ["genre"],
            "row_limit": 20,
            "color_scheme": "supersetColors",
            "show_labels": True,
            "show_legend": True,
        },
    )
    print(f"  Revenue Share by Genre id={genre_revenue_pie_id}")

    # ─── Dashboards ──────────────────────────────────────────────────────────
    print("Creating dashboards...")

    dash1_id = upsert_dashboard(
        session, token, csrf_token,
        "Book Store Analytics",
        [bar_chart_id, line_chart_id, revenue_by_author_id, top_books_id, price_dist_id],
    )
    print(f"  Book Store Analytics id={dash1_id}")

    dash2_id = upsert_dashboard(
        session, token, csrf_token,
        "Sales & Revenue Analytics",
        [total_revenue_kpi_id, total_orders_kpi_id, avg_order_kpi_id,
         order_status_id, avg_order_time_id],
    )
    print(f"  Sales & Revenue Analytics id={dash2_id}")

    dash3_id = upsert_dashboard(
        session, token, csrf_token,
        "Inventory Analytics",
        [inv_health_table_id, stock_vs_reserved_id, inv_turnover_id,
         revenue_by_genre_id, stock_status_pie_id, genre_revenue_pie_id],
    )
    print(f"  Inventory Analytics id={dash3_id}")

    print("")
    print("Superset bootstrap complete.")
    print(f"  Dashboard 1: Book Store Analytics (id={dash1_id})")
    print(f"    URL: {SUPERSET_URL}/superset/dashboard/{dash1_id}/")
    print(f"  Dashboard 2: Sales & Revenue Analytics (id={dash2_id})")
    print(f"    URL: {SUPERSET_URL}/superset/dashboard/{dash2_id}/")
    print(f"  Dashboard 3: Inventory Analytics (id={dash3_id})")
    print(f"    URL: {SUPERSET_URL}/superset/dashboard/{dash3_id}/")


if __name__ == "__main__":
    main()
