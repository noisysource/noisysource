import { createHash, randomBytes } from 'node:crypto';

/**
 * Just enough ONVIF to pan and tilt a Tapo camera: WS-Security UsernameToken
 * (digest) and two PTZ calls. Tapo serves ONVIF on port 2020 at
 * `/onvif/service`, with the camera account from the Tapo app. Written out by
 * hand rather than pulling in an ONVIF library: four SOAP bodies don't justify
 * an XML stack on a 256 MB Pi.
 */

export type PtzDirection = 'left' | 'right' | 'up' | 'down';

/** Pan/tilt velocity per direction, in ONVIF's generic space (-1…1). */
export const VELOCITY: Record<PtzDirection, { x: number; y: number }> = {
  left: { x: -0.5, y: 0 }, right: { x: 0.5, y: 0 }, up: { x: 0, y: 0.5 }, down: { x: 0, y: -0.5 },
};

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** PasswordDigest = Base64(SHA1(nonce + created + password)), nonce sent Base64. */
export function usernameToken(username: string, password: string, nonce?: Uint8Array, created = new Date()) {
  const n = nonce ? Buffer.from(nonce) : randomBytes(16);
  const createdIso = created.toISOString();
  const digest = createHash('sha1').update(Buffer.concat([n, Buffer.from(createdIso), Buffer.from(password)]))
    .digest('base64');
  return { digest, nonce: n.toString('base64'), created: createdIso, username };
}

export function envelope(body: string, username: string, password: string, nonce?: Uint8Array, created?: Date) {
  const t = usernameToken(username, password, nonce, created);
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
    '<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
    '<UsernameToken>' +
    `<Username>${xmlEscape(t.username)}</Username>` +
    '<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">' +
    `${t.digest}</Password>` +
    '<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">' +
    `${t.nonce}</Nonce>` +
    `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${t.created}</Created>` +
    '</UsernameToken></Security></s:Header>' +
    `<s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">${body}</s:Body>` +
    '</s:Envelope>';
}

export const getProfilesBody = () => '<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>';

export function continuousMoveBody(profile: string, dir: PtzDirection) {
  const v = VELOCITY[dir];
  return '<ContinuousMove xmlns="http://www.onvif.org/ver20/ptz/wsdl">' +
    `<ProfileToken>${xmlEscape(profile)}</ProfileToken>` +
    `<Velocity><PanTilt x="${v.x}" y="${v.y}" xmlns="http://www.onvif.org/ver10/schema"/></Velocity>` +
    '</ContinuousMove>';
}

export function stopBody(profile: string) {
  return '<Stop xmlns="http://www.onvif.org/ver20/ptz/wsdl">' +
    `<ProfileToken>${xmlEscape(profile)}</ProfileToken><PanTilt>true</PanTilt><Zoom>false</Zoom></Stop>`;
}

/** The first media profile's token, from a GetProfiles answer (any namespace prefix). */
export function firstProfileToken(xml: string): string | undefined {
  return xml.match(/<(?:\w+:)?Profiles\b[^>]*\btoken="([^"]+)"/)?.[1];
}

/** A SOAP fault's reason, if the answer is one. */
export function faultReason(xml: string): string | undefined {
  if (!/<(?:\w+:)?Fault\b/.test(xml)) return undefined;
  return xml.match(/<(?:\w+:)?Text\b[^>]*>([^<]*)</)?.[1]?.trim() || 'SOAP fault';
}
