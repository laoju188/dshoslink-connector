import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validHistory, validInstallEvent, type InstallEvent, type MaintenanceHistory } from './maintenance-diagnostic.js'

export function readInstallerDiagnostic(baseUrl:string|undefined):MaintenanceHistory<InstallEvent>|undefined {
  try {
    if(!baseUrl)return
    const url=new URL(baseUrl)
    if(url.protocol!=='file:'||url.search||url.hash||!url.pathname.endsWith('/'))return
    const path=join(fileURLToPath(url),'.dshos-link','desktop-installer','install-diagnostic-v1.json')
    const stat=lstatSync(path)
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)return
    const value:unknown=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''))
    return validHistory(value,validInstallEvent)?value:undefined
  } catch {return undefined}
}
