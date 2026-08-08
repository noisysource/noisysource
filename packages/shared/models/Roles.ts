export enum Role {
  Owner        = 'owner',
  FinhubAdmin  = 'finhubAdmin',
  RainbowAdmin = 'rainbowAdmin',
  DomoticsAdmin = 'domoticsAdmin',
  Teacher      = 'teacher',
  Driver       = 'driver',
  Animators    = 'animators',
}

export const ROLE_LABELS: Record<Role, string> = {
  [Role.Owner]:         'Owner',
  [Role.FinhubAdmin]:   'FinHub',
  [Role.RainbowAdmin]:  'KidClub',
  [Role.DomoticsAdmin]: 'Domotics',
  [Role.Teacher]:       'Teacher',
  [Role.Driver]:        'Driver',
  [Role.Animators]:     'Animator',
};