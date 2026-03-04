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
    }
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
    }
  };
}

export function createNormalizingStream(
  inner: AsyncIterable<string>,
  normalize: (text: string) => string
): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      let accumulated = "";
      let emitted = 0;
      for await (const chunk of inner) {
        accumulated += chunk;
        const lastNewline = accumulated.lastIndexOf("\n");

        if (lastNewline === -1) {
          const delta = accumulated.slice(emitted);
          if (delta) {
            yield delta;
            emitted = accumulated.length;
          }
          continue;
        }

        const stable = accumulated.slice(0, lastNewline + 1);
        const normalized = normalize(stable);
        const delta = normalized.slice(emitted);
        emitted = normalized.length;
        if (delta) yield delta;
      }

      if (accumulated) {
        const normalized = normalize(accumulated);
        const delta = normalized.slice(emitted);
        if (delta) yield delta;
      }
    }
  };
}
