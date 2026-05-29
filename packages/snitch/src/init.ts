import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type InitScope = 'global' | 'project';
export type NarrationBackend = 'kokoro' | 'say';

export type InitOptions = {
  scope: InitScope;
  backend: NarrationBackend;
  cwd?: string;
  homeDir?: string;
  serviceUrl?: string;
  serviceCommand?: string;
  packageManager?: 'bun' | 'npm';
  installPackages?: boolean;
  downloadModel?: boolean;
  startService?: boolean;
  sourceRoot?: string;
};

export type InitResult = {
  opencodeConfigPath: string;
  tuiConfigPath: string;
  launchAgentPath: string;
  modelDir?: string;
};

type JsonObject = Record<string, unknown>;
// eslint-disable-next-line no-unused-vars
type CommandRunner = (args: string[], cwd?: string) => Promise<void>;
// eslint-disable-next-line no-unused-vars
type RuntimeMaterializer = (homeDir: string) => Promise<void>;
// eslint-disable-next-line no-unused-vars
type PackageDistPath = (packageName: string) => string;

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:4766';
const SERVICE_LABEL = 'ai.applauselab.snitch';
const RUNTIME_DEPENDENCIES = {
  '@huggingface/transformers': '^3.5.1',
  'kokoro-js': '^1.2.1',
};
function runtimeDir(homeDir: string): string {
  return join(homeDir, '.snitch');
}

function kokoroCacheDir(homeDir: string): string {
  return join(runtimeDir(homeDir), 'models', 'kokoro');
}

function runtimeInstallDir(homeDir: string): string {
  return join(runtimeDir(homeDir), 'runtime');
}

function installedPackagePath(homeDir: string, packageName: string): string {
  return join(runtimeInstallDir(homeDir), 'node_modules', packageName);
}

function serviceEntrypoint(homeDir: string): string {
  return join(runtimeDir(homeDir), 'service', 'index.js');
}

function pluginEntrypoint(homeDir: string): string {
  return join(runtimeDir(homeDir), 'opencode-plugin', 'index.js');
}

function tuiEntrypoint(homeDir: string): string {
  return join(runtimeDir(homeDir), 'opencode-plugin', 'tui.js');
}

function initPaths(options: Required<Pick<InitOptions, 'scope' | 'cwd' | 'homeDir'>>) {
  if (options.scope === 'global') {
    const configRoot = join(options.homeDir, '.config', 'opencode');
    return {
      opencodeConfigPath: join(configRoot, 'opencode.json'),
      tuiConfigPath: join(configRoot, 'tui.json'),
    };
  }

  return {
    opencodeConfigPath: join(options.cwd, 'opencode.json'),
    tuiConfigPath: join(options.cwd, '.opencode', 'tui.json'),
  };
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonObject;
}

async function readJson(path: string): Promise<JsonObject> {
  try {
    return asObject(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
}

function samePlugin(entry: unknown, packageName: string): boolean {
  if (entry === packageName) return true;
  if (packageName.endsWith('/opencode-plugin/index.js')) {
    if (entry === 'opencode-plugin-snitch') return true;
  }
  if (packageName.endsWith('/opencode-plugin/tui.js')) {
    if (entry === 'opencode-plugin-snitch-tui') return true;
  }
  if (!Array.isArray(entry)) return false;
  if (packageName.endsWith('/opencode-plugin/index.js')) {
    if (entry[0] === 'opencode-plugin-snitch') return true;
  }
  if (packageName.endsWith('/opencode-plugin/tui.js')) {
    if (entry[0] === 'opencode-plugin-snitch-tui') return true;
  }
  return entry[0] === packageName;
}

function withPlugin(config: JsonObject, packageName: string, options: JsonObject): JsonObject {
  const existing = Array.isArray(config.plugin) ? config.plugin : [];
  const pluginEntry = Object.keys(options).length === 0 ? packageName : [packageName, options];
  return {
    ...config,
    $schema:
      typeof config.$schema === 'string' ? config.$schema : 'https://opencode.ai/config.json',
    plugin: [...existing.filter((entry) => !samePlugin(entry, packageName)), pluginEntry],
  };
}

export async function writeJson(path: string, data: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

export async function configureOpenCode(options: InitOptions): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const serviceUrl = options.serviceUrl ?? DEFAULT_SERVICE_URL;
  const paths = initPaths({ scope: options.scope, cwd, homeDir });

  const opencodeConfig = withPlugin(
    await readJson(paths.opencodeConfigPath),
    pluginEntrypoint(homeDir),
    {
      backend: options.backend,
      serviceUrl,
    }
  );
  const tuiConfig = withPlugin(await readJson(paths.tuiConfigPath), tuiEntrypoint(homeDir), {
    toggleFile: '.opencode-snitch-off',
  });

  await writeJson(paths.opencodeConfigPath, opencodeConfig);
  await writeJson(paths.tuiConfigPath, tuiConfig);

  return {
    ...paths,
    launchAgentPath: join(homeDir, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
    modelDir: options.backend === 'kokoro' ? kokoroCacheDir(homeDir) : undefined,
  };
}

function plistEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function launchAgentPlist(options: {
  backend: NarrationBackend;
  homeDir: string;
  serviceCommand?: string;
  modelDir?: string;
}): string {
  const serviceCommand =
    options.serviceCommand ??
    `${process.execPath} ${shellQuote(serviceEntrypoint(options.homeDir))}`;
  const logPath = join(runtimeDir(options.homeDir), 'logs', 'snitch.log');
  const errorLogPath = join(runtimeDir(options.homeDir), 'logs', 'snitch.err.log');
  const env: string[] = [`NARRATION_BACKEND=${options.backend}`];
  if (options.modelDir) env.push(`NARRATION_KOKORO_CACHE_DIR=${options.modelDir}`);

  const shellCommand = [...env, serviceCommand].join(' ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${plistEscape(shellCommand)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${plistEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${plistEscape(errorLogPath)}</string>
</dict>
</plist>
`;
}

export async function configureLaunchAgent(options: InitOptions): Promise<string> {
  const homeDir = options.homeDir ?? homedir();
  const modelDir = options.backend === 'kokoro' ? kokoroCacheDir(homeDir) : undefined;
  const launchAgentPath = join(homeDir, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  await mkdir(dirname(launchAgentPath), { recursive: true });
  await mkdir(join(runtimeDir(homeDir), 'logs'), { recursive: true });
  await writeFile(
    launchAgentPath,
    launchAgentPlist({
      backend: options.backend,
      homeDir,
      serviceCommand: options.serviceCommand,
      modelDir,
    })
  );
  return launchAgentPath;
}

export async function prepareKokoroCache(homeDir = homedir()): Promise<string> {
  const modelDir = kokoroCacheDir(homeDir);
  await mkdir(modelDir, { recursive: true });
  return modelDir;
}

export async function installRuntimePackages(
  packageManager: 'bun' | 'npm' = 'bun',
  runner: CommandRunner = runCommand,
  homeDir = homedir(),
  materializer: RuntimeMaterializer = materializeRuntimeFiles
): Promise<void> {
  const dir = runtimeInstallDir(homeDir);
  await mkdir(dir, { recursive: true });
  const packageJsonPath = join(dir, 'package.json');
  if (!(await Bun.file(packageJsonPath).exists())) {
    await writeJson(packageJsonPath, {
      private: true,
      type: 'module',
      dependencies: {},
    });
  }

  if (packageManager === 'bun') {
    await runner(
      ['bun', 'add', 'opencode-plugin-snitch', 'opencode-plugin-snitch-tui', 'snitch-service'],
      dir
    );
    await materializer(homeDir);
    return;
  }

  await runner(
    ['npm', 'install', 'opencode-plugin-snitch', 'opencode-plugin-snitch-tui', 'snitch-service'],
    dir
  );
  await materializer(homeDir);
}

export async function installRuntimeFromSource(
  sourceRoot: string,
  runner: CommandRunner = runCommand,
  homeDir = homedir()
): Promise<void> {
  const dir = runtimeInstallDir(homeDir);
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, 'package.json'), {
    private: true,
    type: 'module',
    dependencies: RUNTIME_DEPENDENCIES,
  });

  await runner(['bun', 'install'], sourceRoot);
  await runner(['bun', 'run', 'build'], sourceRoot);
  await runner(['bun', 'install'], dir);
  await materializeRuntimeFilesFromSource(sourceRoot, homeDir);
}

async function materializeRuntimeFiles(homeDir: string): Promise<void> {
  await materializeRuntimeFilesFromPackages(homeDir, (packageName) =>
    join(installedPackagePath(homeDir, packageName), 'dist')
  );
}

async function materializeRuntimeFilesFromSource(
  sourceRoot: string,
  homeDir: string
): Promise<void> {
  await materializeRuntimeFilesFromPackages(homeDir, (packageName) =>
    join(sourceRoot, 'packages', packageName, 'dist')
  );
}

async function materializeRuntimeFilesFromPackages(
  homeDir: string,
  distPath: PackageDistPath
): Promise<void> {
  const root = runtimeDir(homeDir);
  const serviceDir = join(root, 'service');
  const pluginDir = join(root, 'opencode-plugin');

  await rm(serviceDir, { recursive: true, force: true });
  await rm(pluginDir, { recursive: true, force: true });
  await mkdir(serviceDir, { recursive: true });
  await mkdir(pluginDir, { recursive: true });

  await cp(distPath('snitch-service'), serviceDir, {
    recursive: true,
  });
  await cp(join(distPath('opencode-plugin-snitch'), 'index.js'), join(pluginDir, 'index.js'));
  await cp(join(distPath('opencode-plugin-snitch-tui'), 'index.js'), join(pluginDir, 'tui.js'));

  await symlink(join('..', 'runtime', 'node_modules'), join(serviceDir, 'node_modules'), 'dir');
}

async function runCommand(command: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${command[0]} exited with code ${code}`);
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  if (options.installPackages !== false) {
    if (options.sourceRoot) {
      await installRuntimeFromSource(options.sourceRoot, runCommand, options.homeDir ?? homedir());
    } else {
      await installRuntimePackages(
        options.packageManager ?? 'bun',
        runCommand,
        options.homeDir ?? homedir()
      );
    }
  }

  const result = await configureOpenCode(options);

  if (options.backend === 'kokoro' && options.downloadModel !== false) {
    result.modelDir = await prepareKokoroCache(options.homeDir ?? homedir());
  }

  result.launchAgentPath = await configureLaunchAgent(options);
  if (options.startService !== false) {
    await runCommand([
      '/bin/zsh',
      '-lc',
      `launchctl unload -w ${shellQuote(result.launchAgentPath)} 2>/dev/null; launchctl load -w ${shellQuote(result.launchAgentPath)}`,
    ]);
  }

  return result;
}
