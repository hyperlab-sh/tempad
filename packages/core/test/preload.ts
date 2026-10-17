import { isolateProcessEnvironment } from "./isolation.ts";

// Registered by bunfig.toml: runs once before any test file, so no test sees the developer's
// HOME, CLAUDE_CONFIG_DIR, TEMPAD_* or credentials.
const restore = isolateProcessEnvironment();
process.on("exit", restore);
