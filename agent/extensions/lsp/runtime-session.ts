import { Context } from "effect";

import type { LspRuntimeSessionShape } from "./runtime-types";

export class LspRuntimeSession extends Context.Service<LspRuntimeSession, LspRuntimeSessionShape>()(
	"pi/lsp/LspRuntimeSession",
) {}
