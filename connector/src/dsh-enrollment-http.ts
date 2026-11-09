import type {PairingV1HttpRequest,PairingV1HttpResponse} from './pairing-backend.js'
import type {DshEnrollment} from './dsh-enrollment.js'
// Existing retirement journals remain owned by DshEnrollment. This LAN
// enrollment endpoint cannot initiate or resume retired QR handshakes.
export class DshEnrollmentHttp {
  constructor(readonly enrollment:DshEnrollment){}
  close():void{this.enrollment.close()}
  async handle(_request:PairingV1HttpRequest,_source:string|undefined):Promise<PairingV1HttpResponse>{
    return {status:426,contentType:'application/json',body:'{"error":"pairing_upgrade_required"}'}
  }
}
