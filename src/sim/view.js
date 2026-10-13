// A view frame: the plane parallel to the screen that sketches are projected on.
// `normal` points out of the screen toward the user, so a larger view-space z is
// closer to the user ("over").

export function makeView(origin = [0, 0, 0], right = [1, 0, 0], up = [0, 1, 0], normal = [0, 0, 1]) {
  return { origin, right, up, normal };
}

export function toView(view, x, y, z) {
  const o = view.origin;
  const dx = x - o[0], dy = y - o[1], dz = z - o[2];
  const { right: r, up: u, normal: n } = view;
  return [
    dx * r[0] + dy * r[1] + dz * r[2],
    dx * u[0] + dy * u[1] + dz * u[2],
    dx * n[0] + dy * n[1] + dz * n[2],
  ];
}

export function toWorld(view, x, y, z) {
  const { origin: o, right: r, up: u, normal: n } = view;
  return [
    o[0] + x * r[0] + y * u[0] + z * n[0],
    o[1] + x * r[1] + y * u[1] + z * n[1],
    o[2] + x * r[2] + y * u[2] + z * n[2],
  ];
}
