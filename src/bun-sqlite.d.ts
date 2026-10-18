declare module "bun:sqlite" {
  export interface Changes {
    changes: number;
    lastInsertRowid: number;
  }

  export interface Statement<T = Record<string, unknown>> {
    run(...parameters: unknown[]): Changes;
    get<R = T>(...parameters: unknown[]): R | null;
    all<R = T>(...parameters: unknown[]): R[];
  }

  export class Database {
    constructor(filename: string, options?: { readonly?: boolean });
    exec(sql: string): void;
    query<T = Record<string, unknown>>(sql: string): Statement<T>;
    transaction<T>(callback: () => T): () => T;
    close(): void;
  }
}
