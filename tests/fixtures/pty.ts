export function createFakePty() {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<() => void>();
  const fake = {
    writes: [] as string[],
    resizes: [] as Array<[number, number]>,
    killCount: 0,
    failInput: false,
    failResize: false,
    emitData(data: string) {
      for (const listener of dataListeners) listener(data);
    },
    emitExit() {
      for (const listener of exitListeners) listener();
    },
    get subscriptionCount() {
      return dataListeners.size + exitListeners.size;
    },
    process: {
      write(data: string) {
        if (fake.failInput) throw new Error("PTY write failed");
        fake.writes.push(data);
      },
      resize(cols: number, rows: number) {
        if (fake.failResize) throw new Error("PTY resize failed");
        fake.resizes.push([cols, rows]);
      },
      kill() {
        fake.killCount++;
        fake.emitExit();
      },
      onData(listener: (data: string) => void) {
        dataListeners.add(listener);
        return { dispose: () => dataListeners.delete(listener) };
      },
      onExit(listener: () => void) {
        exitListeners.add(listener);
        return { dispose: () => exitListeners.delete(listener) };
      },
    },
  };
  return fake;
}
