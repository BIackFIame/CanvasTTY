export interface CanvasLinkState {
  enabled: boolean;
  phase: string;
  pin: string;
  expires: number;
  devices: Array<{ name: string }>;
}

export type CanvasLinkCommand = "enable" | "disable" | "new-code" | "revoke";

export interface CanvasLinkApi {
  state(): Promise<CanvasLinkState>;
  command(action: CanvasLinkCommand): Promise<CanvasLinkState>;
}
