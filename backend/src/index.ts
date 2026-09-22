/**
 * Cloudflare Worker entry point for the TrafficVaultHub API.
 */
import { createApp } from "./app";

const app = createApp();

export default app;
