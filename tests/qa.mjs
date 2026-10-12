// The QA script selects presets by their *note* text, which is unique, instead of
// by name (names can collide with frame cards in the category list).
export default async function run(page, ui) {
  const read = () => page.evaluate(() => JSON.parse(document.documentElement.dataset.fpvDebug || '{}'));
  const shots = [];
  const shot = async (name) => {
    const p = `C:/Users/kariston/AppData/Local/Temp/opencode/${name}.png`;
    await page.screenshot({ path: p });
    shots.push(p);
  };
  const preset = (re) => page.locator('#builder-cats button', { hasText: re }).first().click();
  const statText = () => page.evaluate(() => ({
    top: [...document.querySelectorAll('#stats .stat')].slice(0, 3)
      .map((s) => s.innerText.replace('\n', '=')),
    warns: [...document.querySelectorAll('#warnings .warn-row')].map((w) => w.innerText.slice(0, 80)),
  }));

  const out = { presets: {} };
  await page.waitForFunction(() => document.documentElement.dataset.fpvLab === 'ready');
  await page.waitForTimeout(600);
  await shot('qa-builder');

  // Walk every preset and confirm each one is a legal, flyable build. Scope the
  // locator to the presets list, since a part card can share the same name.
  const names = ['Street racing 5"', 'Cinewhoop 3"', 'Freestyle 5"', 'Long range 7"',
    'Toothpick 3"', 'Heavy lifter 9"', 'X-class lifter'];
  for (const n of names) {
    await page.locator('#builder-cats .list button', { hasText: n }).first().click();
    await page.waitForTimeout(450);
    out.presets[n] = await statText();
  }

  // Back to the racer, then fly it.
  await preset(/Street racing 5"/);
  await page.waitForTimeout(500);
  await shot('qa-builder');

  await page.getByRole('button', { name: 'Simulator' }).click();
  await page.waitForTimeout(300);
  // Horizon, not acro: acro has no self-levelling, so holding pitch just tumbles
  // the craft into a wall and every screenshot shows a crashed quad.
  await page.getByRole('button', { name: 'Horizon', exact: true }).click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Arm', exact: true }).click();
  // Tap the throttle rather than holding it: full throttle from the floor in a
  // hangar just buries the craft in the roof, which is a fine physics result but
  // a useless screenshot.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.down('Space');
    await page.waitForTimeout(220);
    await page.keyboard.up('Space');
    await page.waitForTimeout(180);
  }
  await page.waitForTimeout(400);
  await shot('qa-sim-chase');
  out.simChase = await read();

  await page.locator('.cam-switch button', { hasText: 'FPV' }).first().click();
  await page.waitForTimeout(400);
  await shot('qa-sim-fpv');
  out.simFpv = await read();

  // Deliberately fly through a wall to prove collision works.
  await page.locator('.cam-switch button', { hasText: 'Chase' }).first().click();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1200);
  out.pushedIntoWall = await read();
  await page.keyboard.up('KeyW');
  await shot('qa-sim-wall');

  await page.getByRole('button', { name: 'Tune', exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Run step test' }).click();
  await page.waitForTimeout(1000);
  await shot('qa-tune');
  out.tune = await page.evaluate(() => ({
    sliders: document.querySelectorAll('#pid input[type=range]').length,
    messages: [...document.querySelectorAll('#messages div')].map((d) => d.innerText).filter(Boolean),
  }));

  await page.getByRole('button', { name: 'Race', exact: true }).click();
  await page.waitForTimeout(700);
  await shot('qa-race');
  await page.getByRole('button', { name: 'Start heat' }).click();
  await page.waitForTimeout(400);
  // Start heat must actually arm the race. It used to throw partway through and
  // leave the race stuck in 'ready', silently disabling every gate. That throw
  // surfaced as an uncaught error, which the harness reports separately, so the
  // DOM only has to confirm the heat really got under way.
  await page.waitForTimeout(400);
  out.heatStarted = await page.evaluate(() => {
    const debug = JSON.parse(document.documentElement.dataset.fpvDebug || '{}');
    return {
      race: debug.race,
      panel: (document.querySelector('#racepanel') || {}).innerText.replace(/\s+/g, ' ').trim().slice(0, 120),
    };
  });
  await shot('qa-race-finish');
  await page.getByRole('button', { name: 'Arm', exact: true }).click().catch(() => {});
  await page.keyboard.down('Space');
  await page.waitForTimeout(1000);
  await page.keyboard.up('Space');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500);
  await page.keyboard.up('KeyW');
  await shot('qa-race-flying');
  out.raceFlying = await read();

  out.shots = shots;
  return out;
}