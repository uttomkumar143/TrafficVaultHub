import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Unmount rendered trees between tests so state never leaks across cases.
afterEach(() => {
  cleanup();
});
