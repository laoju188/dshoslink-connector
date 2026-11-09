import {Service,type Context} from '@deepseek-ai/cordis'
import type {DshEnrollment} from './dsh-enrollment.js'
import type {PairingOverlaySnapshot} from './pairing-overlay.js'
import type {PairingConnectorStatusSnapshot} from './pairing-port-control.js'
export interface PairingFlowStatus {
  connectorStatus:PairingConnectorStatusSnapshot|null
  legacySnapshot:PairingOverlaySnapshot|null
  enrollment:{window:null;legacyAllowed:false;legacyManagement:boolean}|null
}
interface ExistingPairingControl {snapshot():PairingOverlaySnapshot|null;connectorStatus():PairingConnectorStatusSnapshot|null}
// Existing bindings may be viewed/removed; pairing creation belongs solely to CloudPairingRemote.
export class DshEnrollmentRemote extends Service {
  readonly typertRemote:{service:DshEnrollmentRemote;serviceKey:'dshosEnrollment';namespace:'dshosEnrollment'}
  constructor(ctx:Context,private readonly current:()=>DshEnrollment|undefined,private readonly legacy:ExistingPairingControl){
    super(ctx,'dshosEnrollment')
    this.typertRemote=Object.freeze({service:this,serviceKey:'dshosEnrollment',namespace:'dshosEnrollment'})
  }
  status():PairingFlowStatus {
    const core=this.current()
    return {connectorStatus:this.legacy.connectorStatus(),legacySnapshot:this.legacy.snapshot(),
      enrollment:core?{window:null,legacyAllowed:false,legacyManagement:core.hasLegacyManagement}:null}
  }
}
