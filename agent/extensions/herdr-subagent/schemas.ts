import { Schema } from "effect";

export const RegistryEntrySchema = Schema.Struct({
	name: Schema.String,
	phase: Schema.optional(Schema.Literals(["reserved", "active"])),
	ownerPaneId: Schema.optional(Schema.String),
	target: Schema.optional(Schema.String),
	paneId: Schema.optional(Schema.String),
	tabId: Schema.optional(Schema.String),
	workspaceId: Schema.optional(Schema.String),
	terminalId: Schema.optional(Schema.String),
	cwd: Schema.String,
	label: Schema.String,
	agentType: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
	taskFile: Schema.String,
	systemPromptFile: Schema.optional(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
});

const HerdrAgentSchema = Schema.Struct({
	pane_id: Schema.optional(Schema.String),
	terminal_id: Schema.optional(Schema.String),
	tab_id: Schema.optional(Schema.String),
	workspace_id: Schema.optional(Schema.String),
	agent_status: Schema.optional(Schema.String),
	focused: Schema.optional(Schema.Boolean),
	cwd: Schema.optional(Schema.String),
	foreground_cwd: Schema.optional(Schema.String),
});

export type HerdrAgent = Schema.Schema.Type<typeof HerdrAgentSchema>;

const HerdrPaneSchema = Schema.Struct({
	pane_id: Schema.optional(Schema.String),
	terminal_id: Schema.optional(Schema.String),
	tab_id: Schema.optional(Schema.String),
	workspace_id: Schema.optional(Schema.String),
	cwd: Schema.optional(Schema.String),
	foreground_cwd: Schema.optional(Schema.String),
});

export type HerdrPane = Schema.Schema.Type<typeof HerdrPaneSchema>;

const HerdrTabSchema = Schema.Struct({
	tab_id: Schema.optional(Schema.String),
	workspace_id: Schema.optional(Schema.String),
	label: Schema.optional(Schema.String),
});

const HerdrAgentGetResponseSchema = Schema.Struct({
	result: Schema.Struct({ agent: HerdrAgentSchema }),
});

const HerdrAgentListResponseSchema = Schema.Struct({
	result: Schema.Struct({ agents: Schema.Array(HerdrAgentSchema) }),
});

const HerdrPaneCurrentResponseSchema = Schema.Struct({
	result: Schema.Struct({ pane: Schema.optional(HerdrPaneSchema) }),
});

const HerdrTabGetResponseSchema = Schema.Struct({
	result: Schema.Struct({ tab: HerdrTabSchema }),
});

const HerdrTabCreateResponseSchema = Schema.Struct({
	result: Schema.Struct({
		root_pane: Schema.optional(HerdrPaneSchema),
		pane: Schema.optional(HerdrPaneSchema),
		tab: Schema.optional(HerdrTabSchema),
	}),
});

export const decodeJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
export const decodeRegistryEntry = Schema.decodeUnknownEffect(RegistryEntrySchema);
export const decodeAgentGetResponse = Schema.decodeUnknownEffect(HerdrAgentGetResponseSchema);
export const decodeAgentListResponse = Schema.decodeUnknownEffect(HerdrAgentListResponseSchema);
export const decodePaneCurrentResponse = Schema.decodeUnknownEffect(HerdrPaneCurrentResponseSchema);
export const decodeTabGetResponse = Schema.decodeUnknownEffect(HerdrTabGetResponseSchema);
export const decodeTabCreateResponse = Schema.decodeUnknownEffect(HerdrTabCreateResponseSchema);
