type WorkObject = { provider: string; key: string };

class WorkObjectIdentityManager {
  constructor(private readonly object: WorkObject) {}

  getIdentity(): string {
    return JSON.stringify([this.object.provider, this.object.key]);
  }
}

function createWorkObjectIdentityManager(object: WorkObject) {
  return new WorkObjectIdentityManager(object);
}

export function workObjectId(object: WorkObject): string {
  return createWorkObjectIdentityManager(object).getIdentity();
}
