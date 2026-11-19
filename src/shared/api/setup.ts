export interface SetupStatusResponse {
  ok: true;
  firstRun: boolean;
  ready: boolean;
  models: {
    providerCount: number;
    defaultModel: string;
    defaultModelReady: boolean;
    managerModelReady: boolean;
    workerModelReady: boolean;
    ready: boolean;
  };
  terminal: {
    error: string | null;
    ready: boolean;
  };
  projects: {
    count: number;
    ready: boolean;
  };
  agent: {
    preferencesReady: boolean;
  };
}
