import type { PluginModule } from '@opencode-ai/plugin'
import { OpenHarnessCompatPlugin } from './server.js'

const pluginModule: PluginModule = {
	server: OpenHarnessCompatPlugin,
}

export default pluginModule
export { OpenHarnessCompatPlugin }
export type { PluginConfig } from './shared/types.js'
