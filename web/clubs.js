/**
 * clubs.js - the clubs a tag can be mapped to and a capture labelled with.
 * Pure data and a lookup; no DOM, no network.
 */

/** @type {{id: string, name: string}[]} */
export const CLUBS = [
  { id: 'driver', name: 'Driver' },
  { id: 'wood3', name: '3 Wood' },
  { id: 'wood5', name: '5 Wood' },
  { id: 'wood9', name: '9 Wood' },
  { id: 'iron3', name: '3 Iron' },
  { id: 'iron4', name: '4 Iron' },
  { id: 'iron5', name: '5 Iron' },
  { id: 'iron6', name: '6 Iron' },
  { id: 'iron7', name: '7 Iron' },
  { id: 'iron8', name: '8 Iron' },
  { id: 'iron9', name: '9 Iron' },
  { id: 'wedgePW', name: 'Pitching Wedge' },
  { id: 'wedgeAW', name: 'Approach Wedge' },
  { id: 'wedgeGW', name: 'Gap Wedge' },
  { id: 'wedgeSW', name: 'Sand Wedge' },
  { id: 'wedge52', name: '52° Wedge' },
  { id: 'wedge56', name: '56° Wedge' },
  { id: 'wedge60', name: '60° Wedge' },
  { id: 'putter', name: 'Putter' },
];

/**
 * @param {string|null|undefined} id club id from CLUBS, or null when unlabelled
 * @returns {string} the club's display name, or "Unlabelled" for null or unknown ids
 */
export function clubName(id) {
  const club = CLUBS.find((c) => c.id === id);
  return club ? club.name : 'Unlabelled';
}
