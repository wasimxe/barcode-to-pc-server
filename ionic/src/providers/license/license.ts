import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import ElectronStore from 'electron-store';
import { AlertController, AlertOptions } from 'ionic-angular';

import { Config } from '../../../../electron/src/config';
import { DeviceModel } from '../../models/device.model';
import { DevicesProvider } from '../devices/devices';
import { ElectronProvider } from '../electron/electron';
import { UtilsProvider } from '../utils/utils';

/**
 * LicenseProvider comunicates with the subscription-server to see if there is
 * an active subscription for the current machine. (The check is done on app
 * start in the constructor)
 * LicenseProvider provides methods to see wheter a certain feature can be
 * accessed with the active subscription plan.
 * It also provides methods to show to the user license-related messages/pages.
 */
@Injectable()
export class LicenseProvider {
  public static PLAN_FREE = 'barcode-to-pc-free';
  public static PLAN_BASIC = 'barcode-to-pc-basic';
  public static PLAN_PRO = 'barcode-to-pc-pro';
  public static PLAN_UNLIMITED = 'barcode-to-pc-unlimited';

  public activePlan = LicenseProvider.PLAN_FREE;
  public serial = '';

  private store: ElectronStore;

  constructor(
    public http: HttpClient,
    private electronProvider: ElectronProvider,
    private alertCtrl: AlertController,
    private utilsProvider: UtilsProvider,
    private devicesProvider: DevicesProvider,
  ) {
    this.store = new this.electronProvider.ElectronStore();
    this.updateSubscriptionStatus();
    this.devicesProvider.onConnectedDevicesListChange.subscribe(devicesList => {
      let lastDevice = devicesList[devicesList.length - 1];
      this.limitNOMaxConnectedDevices(lastDevice, devicesList);
    })
  }

  /**
   * This method finds out if there is an active subscription for the current
   * machine and saves it locally by contacting the btp-license-server. 
   * 
   * Once it has been executed the other methods of this class will return the
   * corresponding max allowed values for the active subscription plan (eg.
   * getMaxComponentsNumber will return different values based on the active
   * subscription).
   * 
   * This method should be called as soon as the app starts
   * 
   * If no serial is passed it'll try to load it from the storage and silently
   * perform the checks
   * 
   * If the serial is passed it'll prompt the user with dialogs
   */
  updateSubscriptionStatus(serial: string = '') {
    this.activePlan = this.store.get(Config.STORAGE_SUBSCRIPTION, LicenseProvider.PLAN_FREE)
    // this.store.delete(Config.STORAGE_SUBSCRIPTION);

    if (serial) {
      this.serial = serial;
      this.store.set(Config.STORAGE_SERIAL, this.serial);
    } else {
      this.serial = this.store.get(Config.STORAGE_SERIAL, '')
    }

    // Do not bother the license-server if there isn't an active subscription
    if (serial == '' && this.activePlan == LicenseProvider.PLAN_FREE) {
      return;
    }

    this.http.post(Config.URL_CHECK_SUBSCRIPTION, {
      serial: this.serial,
      uuid: this.electronProvider.uuid
    }).subscribe(value => {
      this.store.set(Config.STORAGE_FIRST_LICENSE_CHECK_FAIL_DATE, 0);
      if (value['active'] == true) {

        // The first time that the request is performed the license-server will
        // do a CLAIM procedure that doesn't return the plan name. From the
        // second request on it will respond also with the active plan name.
        if (!value['plan']) {
          // If the plan name isn't in the response it means that this was the
          // first request and that the CLAIM procedure has been executed
          // successfully, so i can do a second request to retreive the plan name
          this.updateSubscriptionStatus(serial);
        } else {
          this.activePlan = value['plan'];
          this.store.set(Config.STORAGE_SUBSCRIPTION, value['plan']);
          this.store.set(Config.STORAGE_NEXT_CHARGE_DATE, value['nextChargeDate']);
          if (serial) {
            this.utilsProvider.showSuccessNativeDialog('The license has been activated successfully')
          }
        }
      } else {
        // When the license-server says that the subscription is not active
        // the user should be propted immediatly, no matter what it's passed a
        // serial
        this.deactivate(true);
        this.utilsProvider.showErrorNativeDialog(value['message']);
      }
    }, (error: HttpErrorResponse) => {
      if (serial) {
        if (error.status == 503) {
          this.utilsProvider.showErrorNativeDialog('Unable to fetch the subscription information, try later (FS problem)');
        } else {
          this.deactivate();
          this.utilsProvider.showErrorNativeDialog('Unable to activate the license. Please make you sure that your internet connection is active and try again. If the error persists please contact the support.');
        }
      } else {
        // Perhaps there is a connection problem, wait a month before asking the
        // user to enable the connection.
        // For simplicty the STORAGE_FIRST_LICENSE_CHECK_FAIL_DATE field is used
        // only within this method
        let firstFailDate = this.store.get(Config.STORAGE_FIRST_LICENSE_CHECK_FAIL_DATE, 0);
        let now = new Date().getTime();
        if (firstFailDate && (now - firstFailDate) > 2592000000) { // 1 month = 2592000000 ms
          this.store.set(Config.STORAGE_FIRST_LICENSE_CHECK_FAIL_DATE, 0);
          this.deactivate();
          this.utilsProvider.showErrorNativeDialog('Unable to verify your subscription plan. Please make you sure that the computer has an active internet connection');
        } else {
          this.store.set(Config.STORAGE_FIRST_LICENSE_CHECK_FAIL_DATE, now);
        }
      }
    })
  }

  deactivate(clearSerial = false) {
    if (clearSerial) {
      this.serial = '';
      this.store.set(Config.STORAGE_SERIAL, this.serial);
    }
    this.activePlan = LicenseProvider.PLAN_FREE;
    this.store.set(Config.STORAGE_SUBSCRIPTION, this.activePlan);
  }

  showPricingPage() {
    this.electronProvider.shell.openExternal(Config.URL_PRICING);
  }

  /**
   * This method must to be called when a new device is connected.
   * It will check if the limit is reached and will show the appropriate
   * messages on both server and app
   * @param device 
   * @param connectedDevices 
   */
  limitNOMaxConnectedDevices(device: DeviceModel, connectedDevices: DeviceModel[]) {
    if (connectedDevices.length > this.getNOMaxAllowedConnectedDevices()) {
      let message = 'You\'ve reached the maximum number of connected devices for your current subscription plan';
      this.devicesProvider.kickDevice(device, message);
      this.showUpgradeDialog('Devices limit raeched', message)
    }
  }

  /**
   * This method should be called when retrieving a set of new scans.
   * It kicks out all devices and shows a dialog when the monthly limit of scans
   * has been exceeded
   */
  limitMonthlyScans(noNewScans = 1) {
    let count = this.store.get(Config.STORAGE_MONTHLY_SCANS_COUNT, 0);
    count += noNewScans;
    this.store.set(Config.STORAGE_MONTHLY_SCANS_COUNT, count);

    if (count > this.getNOMaxAllowedScansPerMonth()) {
      let message = 'You\'ve reached the maximum number of monthly scannings for your current subscription plan.';
      this.devicesProvider.kickAllDevices(message);
      this.showUpgradeDialog('Monthly scans limit raeched', message)
    }
  }

  getNOMaxComponents() {
    switch (this.activePlan) {
      case LicenseProvider.PLAN_FREE: return 4;
      case LicenseProvider.PLAN_BASIC: return 5;
      case LicenseProvider.PLAN_PRO: return 10;
      case LicenseProvider.PLAN_UNLIMITED: return Number.MAX_SAFE_INTEGER;
    }
  }

  getNOMaxAllowedConnectedDevices() {
    switch (this.activePlan) {
      case LicenseProvider.PLAN_FREE: return 1;
      case LicenseProvider.PLAN_BASIC: return 2;
      case LicenseProvider.PLAN_PRO: return 10;
      case LicenseProvider.PLAN_UNLIMITED: return Number.MAX_SAFE_INTEGER;
    }
  }

  getNOMaxAllowedScansPerMonth() {
    switch (this.activePlan) {
      case LicenseProvider.PLAN_FREE: return 1000;
      case LicenseProvider.PLAN_BASIC: return 2000;
      case LicenseProvider.PLAN_PRO: return 10000;
      case LicenseProvider.PLAN_UNLIMITED: return Number.MAX_SAFE_INTEGER;
    }
  }

  canUseQuantityParameter() {
    switch (this.activePlan) {
      case LicenseProvider.PLAN_FREE: return false;
      case LicenseProvider.PLAN_BASIC: return true;
      case LicenseProvider.PLAN_PRO: return true;
      case LicenseProvider.PLAN_UNLIMITED: return true;
    }
  }

  canUseCSVAppend() {
    switch (this.activePlan) {
      case LicenseProvider.PLAN_FREE: return false;
      case LicenseProvider.PLAN_BASIC: return true;
      case LicenseProvider.PLAN_PRO: return true;
      case LicenseProvider.PLAN_UNLIMITED: return true;
    }
  }

  isSubscribed() {
    return this.activePlan != LicenseProvider.PLAN_FREE;
  }

  getPlanName() {
    switch (this.activePlan) {
      case LicenseProvider.PLAN_FREE: return 'Free';
      case LicenseProvider.PLAN_BASIC: return 'Basic';
      case LicenseProvider.PLAN_PRO: return 'Pro';
      case LicenseProvider.PLAN_UNLIMITED: return 'Unlimited'
    }
  }

  private showUpgradeDialog(title, message) {
    this.alertCtrl.create({
      title: title, message: message, buttons: [{ text: 'Close', role: 'cancel' }, {
        text: 'Upgrade', handler: (opts: AlertOptions) => {
          this.showPricingPage();
        }
      }]
    }).present();
  }
}