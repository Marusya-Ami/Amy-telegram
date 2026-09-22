const chains = new Map<string, Promise<void>>();

export async function enqueueUserWork(userId: string, task: () => Promise<void>): Promise<void> {
  const previous = chains.get(userId) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (chains.get(userId) === current) chains.delete(userId);
    });

  chains.set(userId, current);
  await current;
}
