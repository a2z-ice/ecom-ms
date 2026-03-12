import { test, expect } from "@playwright/test";
import { execFileSync } from "child_process";
import { getCnpgPrimaryPod } from "./helpers/db";

/** Helper: run kubectl and return trimmed stdout */
function kubectl(...args: string[]): string {
  return execFileSync("kubectl", args, { encoding: "utf-8" }).trim();
}

/** Helper: parse JSON from kubectl output */
function kubectlJson(...args: string[]): any {
  return JSON.parse(kubectl(...args));
}

/** Helper: sleep for ms */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** All 4 CNPG clusters with their namespaces */
const CLUSTERS = [
  { name: "ecom-db", namespace: "ecom" },
  { name: "inventory-db", namespace: "inventory" },
  { name: "analytics-db", namespace: "analytics" },
  { name: "keycloak-db", namespace: "identity" },
];

/** Clusters that require wal_level=logical for Debezium CDC */
const CDC_CLUSTERS = [
  { name: "ecom-db", namespace: "ecom" },
  { name: "inventory-db", namespace: "inventory" },
];

test.describe("CNPG Operator Health", () => {
  test("cnpg-controller-manager pod is Running", () => {
    const output = kubectl(
      "get",
      "pods",
      "-n",
      "cnpg-system",
      "-l",
      "app.kubernetes.io/name=cloudnative-pg",
      "-o",
      "jsonpath={.items[*].status.phase}"
    );
    const phases = output.split(/\s+/).filter(Boolean);
    expect(phases.length).toBeGreaterThanOrEqual(1);
    for (const phase of phases) {
      expect(phase).toBe("Running");
    }
  });
});

test.describe("CNPG Cluster Health", () => {
  for (const { name, namespace } of CLUSTERS) {
    test(`${name} cluster is in healthy state`, () => {
      const cluster = kubectlJson(
        "get",
        "cluster",
        name,
        "-n",
        namespace,
        "-o",
        "json"
      );
      // CNPG sets status.phase to "Cluster in healthy state" when healthy
      const phase = cluster.status?.phase;
      expect(phase).toBe("Cluster in healthy state");
    });
  }
});

test.describe("CNPG Instance Count", () => {
  for (const { name, namespace } of CLUSTERS) {
    test(`${name} has exactly 2 instances`, () => {
      const cluster = kubectlJson(
        "get",
        "cluster",
        name,
        "-n",
        namespace,
        "-o",
        "json"
      );
      expect(cluster.spec.instances).toBe(2);
      expect(cluster.status.readyInstances).toBe(2);
    });
  }
});

test.describe("CNPG Primary/Standby Roles", () => {
  for (const { name, namespace } of CLUSTERS) {
    test(`${name} has exactly 1 primary and 1 replica`, () => {
      // Get pods for this cluster
      const pods = kubectlJson(
        "get",
        "pods",
        "-n",
        namespace,
        "-l",
        `cnpg.io/cluster=${name}`,
        "-o",
        "json"
      );
      const roles = pods.items.map(
        (p: any) => p.metadata.labels["cnpg.io/instanceRole"] || "unknown"
      );
      const primaries = roles.filter((r: string) => r === "primary");
      const replicas = roles.filter((r: string) => r === "replica");
      expect(primaries.length).toBe(1);
      expect(replicas.length).toBe(1);
    });
  }
});

test.describe("ExternalName Service Aliases", () => {
  for (const { name, namespace } of CLUSTERS) {
    test(`${name} ExternalName service points to ${name}-rw`, () => {
      const svc = kubectlJson(
        "get",
        "svc",
        name,
        "-n",
        namespace,
        "-o",
        "json"
      );
      expect(svc.spec.type).toBe("ExternalName");
      expect(svc.spec.externalName).toBe(
        `${name}-rw.${namespace}.svc.cluster.local`
      );
    });
  }
});

test.describe("Streaming Replication", () => {
  for (const { name, namespace } of CLUSTERS) {
    test(`${name} primary has active streaming replication`, () => {
      const primaryPod = getCnpgPrimaryPod(namespace, name);
      const result = kubectl(
        "exec",
        "-n",
        namespace,
        primaryPod,
        "--",
        "psql",
        "-U",
        "postgres",
        "-tAc",
        "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming';"
      );
      const count = parseInt(result, 10);
      expect(count).toBeGreaterThanOrEqual(1);
    });
  }
});

test.describe("WAL Level for CDC", () => {
  for (const { name, namespace } of CDC_CLUSTERS) {
    test(`${name} has wal_level=logical`, () => {
      const primaryPod = getCnpgPrimaryPod(namespace, name);
      const walLevel = kubectl(
        "exec",
        "-n",
        namespace,
        primaryPod,
        "--",
        "psql",
        "-U",
        "postgres",
        "-tAc",
        "SHOW wal_level;"
      );
      expect(walLevel).toBe("logical");
    });
  }
});

test.describe("CNPG PVC Storage", () => {
  for (const { name, namespace } of CLUSTERS) {
    test(`${name} PVCs use standard storage class and are Bound`, () => {
      const pvcs = kubectlJson(
        "get",
        "pvc",
        "-n",
        namespace,
        "-l",
        `cnpg.io/cluster=${name}`,
        "-o",
        "json"
      );
      expect(pvcs.items.length).toBe(2);
      for (const pvc of pvcs.items) {
        expect(pvc.status.phase).toBe("Bound");
        expect(pvc.spec.storageClassName).toBe("standard");
      }
    });
  }
});

test.describe.serial("Failover Test (ecom-db)", () => {
  let originalPrimary: string;

  test("record current primary pod", () => {
    originalPrimary = getCnpgPrimaryPod("ecom", "ecom-db");
    expect(originalPrimary).toBeTruthy();
  });

  test("delete the primary pod to trigger failover", () => {
    test.setTimeout(60_000);
    kubectl("delete", "pod", "-n", "ecom", originalPrimary, "--wait=false");
  });

  test("cluster recovers to healthy state with 2 ready instances", async () => {
    test.setTimeout(180_000);
    const deadline = Date.now() + 170_000;
    let readyInstances = 0;
    while (Date.now() < deadline) {
      try {
        const cluster = kubectlJson(
          "get",
          "cluster",
          "ecom-db",
          "-n",
          "ecom",
          "-o",
          "json"
        );
        readyInstances = cluster.status?.readyInstances ?? 0;
        if (readyInstances === 2) break;
      } catch {
        // transient error
      }
      await sleep(3_000);
    }
    expect(readyInstances).toBe(2);
  });

  test("cluster has 1 primary and 1 replica after recovery", () => {
    const pods = kubectlJson(
      "get",
      "pods",
      "-n",
      "ecom",
      "-l",
      "cnpg.io/cluster=ecom-db",
      "-o",
      "json"
    );
    const roles = pods.items.map(
      (p: any) => p.metadata.labels["cnpg.io/instanceRole"] || "unknown"
    );
    expect(roles.filter((r: string) => r === "primary").length).toBe(1);
    expect(roles.filter((r: string) => r === "replica").length).toBe(1);
  });

  test("ecom-service reconnects — GET /ecom/books returns 200", async ({
    request,
  }) => {
    test.setTimeout(60_000);
    const url = "https://api.service.net:30000/ecom/books";
    const deadline = Date.now() + 55_000;
    let lastStatus = 0;
    while (Date.now() < deadline) {
      try {
        const resp = await request.get(url, {
          ignoreHTTPSErrors: true,
          timeout: 5_000,
        });
        lastStatus = resp.status();
        if (lastStatus === 200) break;
      } catch {
        // connection may be refused during failover
      }
      await sleep(2_000);
    }
    expect(lastStatus).toBe(200);
  });
});

test.describe("Debezium Resilience After Failover", () => {
  test("debezium-server-ecom health is UP", async ({ request }) => {
    test.setTimeout(120_000);
    const url = "http://localhost:32300/q/health";
    const deadline = Date.now() + 110_000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const resp = await request.get(url, { timeout: 5_000 });
        if (resp.ok()) {
          const body = await resp.json();
          if (body.status === "UP") {
            healthy = true;
            break;
          }
        }
      } catch {
        // may be reconnecting
      }
      await sleep(2_000);
    }
    expect(healthy).toBe(true);
  });

  test("debezium-server-inventory health is UP", async ({ request }) => {
    const resp = await request.get("http://localhost:32301/q/health", {
      timeout: 5_000,
    });
    expect(resp.ok()).toBe(true);
    const body = await resp.json();
    expect(body.status).toBe("UP");
  });
});
