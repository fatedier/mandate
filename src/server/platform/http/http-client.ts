export interface HttpClient {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export const globalHttpClient: HttpClient = {
  fetch(input, init) {
    return fetch(input, init);
  }
};
