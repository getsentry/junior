export function createTextStreamBridge() {
  const queue: string[] = [];
  let ended = false;
  let wakeConsumer: (() => void) | null = null;

  const iterable: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      while (!ended || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift() as string;
          continue;
        }
        await new Promise<void>((resolve) => {
          wakeConsumer = resolve;
        });
      }
    },
  };

  return {
    iterable,
    push(delta: string) {
      if (!delta || ended) {
        return;
      }
      queue.push(delta);
      const wake = wakeConsumer;
      wakeConsumer = null;
      wake?.();
    },
    end() {
      if (ended) {
        return;
      }
      ended = true;
      const wake = wakeConsumer;
      wakeConsumer = null;
      wake?.();
    },
  };
}
