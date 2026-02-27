import type { ClientSecuritySettings } from "./securityTypes";

export type { ClientSecuritySettings };

export interface SecurityRepo {
  getGlobal(): Promise<ClientSecuritySettings>;
  saveGlobal(settings: ClientSecuritySettings): Promise<void>;
  getVideo(videoId: string): Promise<ClientSecuritySettings | null>;
  saveVideo(videoId: string, settings: ClientSecuritySettings): Promise<void>;
  getUseGlobal(videoId: string): Promise<boolean>;
  setUseGlobal(videoId: string, useGlobal: boolean): Promise<void>;
}
