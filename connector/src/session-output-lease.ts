import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
export interface OutputLease { assertHeld(): void; release(): Promise<void> }
/** Read-only OPEN_EXISTING/Share.Read; rejects an unfinished writer and prevents replacement. */
export function closedOutputLease(file: string): Promise<OutputLease> {
  if (process.platform !== 'win32' || !win32.isAbsolute(file) || file.length > 1024 || /[\u0000\r\n]/.test(file))
    return Promise.reject(Error('output_unavailable'))
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !win32.isAbsolute(systemRoot)) return Promise.reject(Error('output_unavailable'))
  return new Promise((resolve, reject) => {
    const script = "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false,$true)\n$ErrorActionPreference='Stop'; $stream=$null\ntry { $p=[Console]::In.ReadLine(); $stream=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('ready'); [Console]::Out.Flush(); $null=[Console]::In.ReadToEnd() } catch { exit 1 } finally { if ($null -ne $stream) { $stream.Dispose() } }"
    const child = spawn(win32.join(systemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-Command',script],
      {windowsHide:true,shell:false,env:{...process.env,PSModulePath:win32.join(systemRoot,'System32/WindowsPowerShell/v1.0/Modules')},stdio:['pipe','pipe','pipe']})
    let ready=false,alive=true,releasing=false,output='',finishClosed=():void=>{}
    const closed=new Promise<void>(r=>{finishClosed=r})
    const finish=():void=>{if(!alive)return;alive=false;clearTimeout(timer);finishClosed();if(!ready)reject(Error('output_unavailable'))}
    const timer=setTimeout(()=>{child.kill();reject(Error('output_unavailable'))},5000)
    child.stdout.on('data',(chunk:Buffer)=>{
      output+=chunk.toString('utf8');if(output.length>32){child.kill();return}
      if(!ready&&output.trim()==='ready'){ready=true;clearTimeout(timer);resolve({
        assertHeld(){if(!alive||releasing)throw Error('output_changed')},
        async release(){releasing=true;child.stdin.end();const deadline=setTimeout(()=>child.kill(),2000);await closed;clearTimeout(deadline)},
      })}
    })
    child.stderr.resume();child.once('error',finish);child.once('close',finish)
    child.stdin.once('error',()=>{child.kill();finish()});child.stdin.write(file+'\n')
  })
}
