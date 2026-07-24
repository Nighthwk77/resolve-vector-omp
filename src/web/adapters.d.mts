export interface WebAdapter {
  url: string;
  family: string;
  inputSelectors: string[];
  responseSelectors: string[];
  popupCloseSelectors: string[];
  stripResponsePrefixes?: string[];
  newChatPerConsult: boolean;
}

export declare const ADAPTERS: Record<string, WebAdapter>;
export declare function getAdapter(app: string): WebAdapter;
