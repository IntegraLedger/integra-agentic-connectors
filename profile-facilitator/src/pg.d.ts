// The part of the pg 8.23.0 API this package calls.
declare module "pg" {
  namespace pg {
    interface QueryResult<R> {
      rows: R[];
      rowCount: number | null;
    }
    interface PoolClient {
      query<R = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
      release(destroy?: boolean | Error): void;
    }
    class Pool {
      constructor(o: {
        connectionString: string;
        max?: number;
        connectionTimeoutMillis?: number;
        query_timeout?: number;
        statement_timeout?: number;
      });
      connect(): Promise<PoolClient>;
      query<R = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
      end(): Promise<void>;
      on(event: "error", listener: (e: Error) => void): this;
    }
  }
  export default pg;
}
