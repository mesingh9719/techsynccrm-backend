import { subscribe } from '../registry.js'
import { deliverInboundReply } from '../../services/inboundDelivery.service.js'

subscribe('inbound-replies', ['inbound.reply_requested'], deliverInboundReply)
