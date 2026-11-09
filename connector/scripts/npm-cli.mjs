#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { diagnoseArguments } from './diagnose.mjs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const PACKAGE_SPEC = `${packageJson.name}@${packageJson.version}`
const USAGE = `用法：npx --yes ${packageJson.name}@latest <install|upgrade|open|status|diagnose|uninstall> [--dsh-home 原数据目录] [--profile 原配置名] [--dsh-path 原DSH程序]`
const MANAGER_PATH = fileURLToPath(
  new URL('./windows/Manage-DshosLinkConnector.ps1', import.meta.url),
)
const ACTIONS = new Set(['install', 'upgrade', 'open', 'status', 'uninstall'])

export function buildManagerArguments(action, options = []) {
  if (!ACTIONS.has(action)) {
    throw new Error(USAGE)
  }
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    MANAGER_PATH,
    '-Action',
    action,
  ]
  if (action === 'install' || action === 'upgrade') {
    args.push('-PackageSpec', PACKAGE_SPEC)
  }
  const names = new Map([['--dsh-home', '-DshHome'], ['--profile', '-Profile'], ['--dsh-path', '-DshPath']])
  const seen = new Set()
  for (let i = 0; i < options.length; i += 2) {
    const name = options[i]
    const value = options[i + 1]
    if (!names.has(name) || seen.has(name) || typeof value !== 'string' ||
      value.trim().length === 0 || value.startsWith('-') || /[\r\n\0]/.test(value)) throw new Error(USAGE)
    if (name === '--profile' && !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error(USAGE)
    seen.add(name)
    args.push(names.get(name), value)
  }
  if (ACTIONS.has(action)) {
    const profileIndex = args.indexOf('-Profile')
    if (['install', 'upgrade', 'open'].includes(action) && profileIndex >= 0 && args[profileIndex + 1] !== 'desktop') throw new Error('当前插件仅支持官方 DSH 桌面版；原网页版数据保持不变。')
    if (profileIndex < 0) args.push('-Profile', 'desktop')
  }
  return args
}

export function runCli(argv = process.argv.slice(2), platform = process.platform) {
  if (platform !== 'win32') {
    throw new Error('DSHOS Link 连接器首发仅支持 Windows。')
  }
  if (argv.length < 1) {
    throw new Error(USAGE)
  }
  if (argv[0] === 'diagnose') {
    console.log(JSON.stringify(diagnoseArguments(argv.slice(1)), null, 2))
    return 0
  }
  const result = spawnSync('powershell.exe', buildManagerArguments(argv[0], argv.slice(1)), {
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  return result.status ?? 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : '连接器操作失败，请重试。')
    process.exitCode = 1
  }
}
