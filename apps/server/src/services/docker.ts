import Docker from "dockerode";

// DOCKER_HOST tanımlı değilse /var/run/docker.sock kullanılır.
export const docker = new Docker();

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Docker yanıt vermedi")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function getDockerInfo() {
  try {
    const info = await withTimeout(docker.info(), 3000);
    return {
      available: true as const,
      version: info.ServerVersion as string,
      containers: { total: info.Containers as number, running: info.ContainersRunning as number },
      images: info.Images as number,
    };
  } catch (err) {
    return { available: false as const, error: (err as Error).message };
  }
}

export async function listContainers() {
  const containers = await withTimeout(docker.listContainers({ all: true }), 5000);
  return containers.map((c) => ({
    id: c.Id.slice(0, 12),
    name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
    image: c.Image,
    state: c.State,
    status: c.Status,
    createdAt: c.Created * 1000,
    ports: c.Ports.filter((p) => p.PublicPort).map((p) => `${p.PublicPort}:${p.PrivatePort}/${p.Type}`),
  }));
}
