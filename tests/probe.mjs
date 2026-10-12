export default async function run(page, ui) {
  return await page.evaluate(() => {
    const a = window.fpvLab;
    if (!a) return { error: 'no fpvLab', bodyHasParts: document.querySelectorAll('.part').length };
    const b = a.viewportB;
    const cam = b.camera;
    // Walk the drone group and report bounding sizes in world units.
    const box = new (window.THREE_BOX3 || Object)();
    let meshCount = 0;
    a.droneB.group.traverse((o) => { if (o.isMesh) meshCount++; });
    return {
      view: a.view,
      droneChildren: a.droneB.group.children.length,
      meshCount,
      droneParent: a.droneB.group.parent === b.droneGroup,
      camPos: [+cam.position.x.toFixed(3), +cam.position.y.toFixed(3), +cam.position.z.toFixed(3)],
      camNear: cam.near, camFar: cam.far, fov: cam.fov, aspect: +cam.aspect.toFixed(2),
      canvas: [b.canvas.width, b.canvas.height, b.canvas.clientWidth, b.canvas.clientHeight],
      bg: b.scene.background ? b.scene.background.getHexString() : null,
      fogNear: b.scene.fog.near, fogFar: b.scene.fog.far,
      groupPos: [a.droneB.group.position.x, a.droneB.group.position.y, a.droneB.group.position.z],
      built: a.droneB.built,
      lights: b.scene.children.filter((c) => c.isLight).length,
    };
  });
}
