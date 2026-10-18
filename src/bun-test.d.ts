declare module "bun:test" {
  export function describe(name: string, callback: () => void): void;
  export function test(name: string, callback: () => void | Promise<void>): void;
  export const expect: (value: unknown) => {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toHaveLength(expected: number): void;
    toMatch(expected: RegExp): void;
    toContain(expected: unknown): void;
    not: {
      toHaveLength(expected: number): void;
      toContain(expected: unknown): void;
      toMatch(expected: RegExp): void;
    };
    toThrow(expected?: RegExp): void;
    toMatchObject(expected: Record<string, unknown>): void;
    toBeUndefined(): void;
  };
}
