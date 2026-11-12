// Dashboard definitions. Edit to match the site's code lists.
// Rig activity codes counted as non-productive time (NPT) on the Progress RIG tab
export const NPT_ACTIVITY = ['STANDBY', 'MOVE_SETUP'];
// Activity code counted as drilling time
export const DRILL_ACTIVITY = 'DRILLING';
// Map class per collar status when the site's code list has no map_class flag
export const STATUS_CLASS_FALLBACK = { planned: 'planned', drilling: 'coh', completed: 'eoh', abandoned: 'eoh' };
