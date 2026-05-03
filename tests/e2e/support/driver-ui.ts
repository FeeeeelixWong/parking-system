import type { Page } from "@playwright/test";

type SavedDriver = {
  id: string;
  name: string;
  phone: string;
};

export async function setSavedDriver(page: Page, driver: SavedDriver) {
  await page.addInitScript((saved) => {
    window.localStorage.setItem("parking_driver", JSON.stringify(saved));
  }, driver);
}

export async function setDeviceId(page: Page, deviceId: string) {
  await page.addInitScript((id) => {
    window.localStorage.setItem("parking_device_id", id);
  }, deviceId);
}

export async function setSavedDriverAndDevice(page: Page, driver: SavedDriver, deviceId: string) {
  await setSavedDriver(page, driver);
  await setDeviceId(page, deviceId);
}
