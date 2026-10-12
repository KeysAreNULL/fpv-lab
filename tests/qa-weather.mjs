// Weather and lighting check. Cycles the Environment panel's weather control so
// the sky, sun angle, fog and rain can be compared side by side, and reads the
// resulting lighting state back off the DOM debug channel.
export default async function run(page) {
  const shots = [];
  const shot = async (name) => {
    const p = `C:/Users/kariston/AppData/Local/Temp/opencode/wx-${name}.png`;
    await page.screenshot({ path: p });
    shots.push(p);
  };
  const out = { presets: {} };
  await page.waitForFunction(() => document.documentElement.dataset.fpvLab === 'ready');
  await page.waitForTimeout(900);

  // The default track is the interior hangar, where weather is deliberately
  // suppressed. Load an outdoor one first or every preset looks the same.
  await page.getByRole('button', { name: 'Race', exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /Desert Tower/ }).click();
  await page.waitForTimeout(700);
  out.track = (await page.locator('#racepanel').innerText()).replace(/\s+/g, ' ').slice(0, 60);

  await page.getByRole('button', { name: 'Simulator' }).click();
  await page.waitForTimeout(700);

  // Drive the real control rather than an internal API: that is the path a user
  // takes, and it is the only one visible from this harness.
  const weatherSel = page.locator('#envcfg .cfg-row')
    .filter({ hasText: 'Weather' }).locator('select');
  const options = await weatherSel.locator('option').allTextContents();
  out.options = options;

  for (const w of ['clear', 'overcast', 'dusk', 'rain', 'fog', 'night']) {
    await weatherSel.selectOption(w);
    await page.waitForTimeout(650);
    out.presets[w] = await page.evaluate(() => {
      const d = JSON.parse(document.documentElement.dataset.fpvDebug || '{}');
      return d.weather || 'no diagnostics';
    });
    await shot(w);
  }
  // Leave it on a readable setting for the other screenshots.
  await weatherSel.selectOption('clear');
  await page.waitForTimeout(400);

  // Sun sliders must drive the same lighting state the preset does.
  const sunRow = page.locator('#envcfg .cfg-row').filter({ hasText: 'Sun elevation' });
  await sunRow.locator('input[type=range]').fill('8');
  await page.waitForTimeout(500);
  out.lowSun = { label: await sunRow.innerText() };
  await shot('clear-lowsun');

  await sunRow.locator('input[type=range]').fill('55');
  await weatherSel.selectOption('clear');
  await page.waitForTimeout(400);

  out.shots = shots;
  return out;
}
