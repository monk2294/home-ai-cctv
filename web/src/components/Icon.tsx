import navCameras from '../assets/icons/nav-cameras.svg';
import navEvents from '../assets/icons/nav-events.svg';
import back from '../assets/icons/back.svg';
import edit from '../assets/icons/edit.svg';
import deleteIcon from '../assets/icons/delete.svg';
import snapshot from '../assets/icons/snapshot.svg';
import sound from '../assets/icons/sound.svg';
import ptzUp from '../assets/icons/ptz-up.svg';
import ptzDown from '../assets/icons/ptz-down.svg';
import ptzLeft from '../assets/icons/ptz-left.svg';
import ptzRight from '../assets/icons/ptz-right.svg';
import ptzUpLeft from '../assets/icons/ptz-upleft.svg';
import ptzUpRight from '../assets/icons/ptz-upright.svg';
import ptzDownLeft from '../assets/icons/ptz-downleft.svg';
import ptzDownRight from '../assets/icons/ptz-downright.svg';
import ptzHome from '../assets/icons/ptz-home.svg';
import zoomIn from '../assets/icons/zoom-in.svg';
import zoomOut from '../assets/icons/zoom-out.svg';
import plus from '../assets/icons/plus.svg';
import preset from '../assets/icons/preset.svg';

const ICONS = {
  'nav-cameras': navCameras,
  'nav-events': navEvents,
  back,
  edit,
  delete: deleteIcon,
  snapshot,
  sound,
  'ptz-up': ptzUp,
  'ptz-down': ptzDown,
  'ptz-left': ptzLeft,
  'ptz-right': ptzRight,
  'ptz-upleft': ptzUpLeft,
  'ptz-upright': ptzUpRight,
  'ptz-downleft': ptzDownLeft,
  'ptz-downright': ptzDownRight,
  'ptz-home': ptzHome,
  'zoom-in': zoomIn,
  'zoom-out': zoomOut,
  plus,
  preset,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <img src={ICONS[name]} alt="" width={size} height={size} aria-hidden="true" />;
}
