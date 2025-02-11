import * as nls from "vscode-nls";
import * as azdata from "azdata";
import { CosmosDBManagementClient } from "@azure/arm-cosmosdb";
import { MonitorManagementClient } from "@azure/arm-monitor";
import { ResourceGraphClient } from "@azure/arm-resourcegraph";
import { TokenCredentials } from "@azure/ms-rest-js";
import { ThroughputSettingsGetPropertiesResource } from "@azure/arm-cosmosdb/esm/models";
import { getServerState } from "../Dashboards/ServerUXStates";
import {
  IConnectionOptions,
  ICosmosDbCollectionInfo,
  ICosmosDbDatabaseAccountInfo,
  ICosmosDbDatabaseInfo,
} from "../models";
import { CdbCollectionCreateInfo } from "../sampleData/DataSamplesUtil";
import { hideStatusBarItem, showStatusBarItem } from "../appContext";

const localize = nls.loadMessageBundle();

export abstract class AbstractArmService {
  public retrievePortalEndpoint = async (accountId: string): Promise<string> =>
    (await this.retrieveAzureAccount(accountId)).properties?.providerSettings?.settings?.portalEndpoint;

  private retrieveAzureAccount = async (accountId: string): Promise<azdata.Account> => {
    showStatusBarItem(localize("retrievingAzureAccount", "Retrieving Azure Account..."));
    const accounts = (await azdata.accounts.getAllAccounts()).filter((a) => a.key.accountId === accountId);
    hideStatusBarItem();
    if (accounts.length < 1) {
      throw new Error(localize("noAzureAccountFound", "No azure account found"));
    }

    return accounts[0];
  };

  protected retrieveAzureToken = async (
    tenantId: string,
    azureAccountId: string
  ): Promise<{ token: string; tokenType?: string | undefined }> => {
    const azureAccount = await this.retrieveAzureAccount(azureAccountId);

    showStatusBarItem(localize("retrievingAzureToken", "Retrieving Azure Token..."));
    const azureToken = await azdata.accounts.getAccountSecurityToken(
      azureAccount,
      tenantId,
      azdata.AzureResource.ResourceManagement
    );
    hideStatusBarItem();

    if (!azureToken) {
      throw new Error(localize("failRetrieveArmToken", "Unable to retrieve ARM token"));
    }

    return azureToken;
  };

  protected parsedAzureResourceId = (
    azureResourceId: string
  ): { subscriptionId: string; resourceGroup: string; dbAccountName: string } => {
    // TODO Add error handling
    const parsedAzureResourceId = azureResourceId.split("/");
    return {
      subscriptionId: parsedAzureResourceId[2],
      resourceGroup: parsedAzureResourceId[4],
      dbAccountName: parsedAzureResourceId[8],
    };
  };

  /**
   * If AzureResourceId is not defined, retrieve from ARM
   * @param azureAccountId
   * @param azureTenantId
   * @param azureResourceId
   * @param cosmosDbAccountName
   * @returns
   */
  public retrieveResourceId = async (
    azureAccountId: string,
    azureTenantId: string,
    azureResourceId: string,
    cosmosDbAccountName: string
  ): Promise<string> => {
    if (!azureResourceId) {
      const azureToken = await this.retrieveAzureToken(azureTenantId, azureAccountId);
      const credentials = new TokenCredentials(azureToken.token, azureToken.tokenType /* , 'Bearer' */);

      const azureResource = await this.retrieveResourceInfofromArm(cosmosDbAccountName, credentials);
      if (!azureResource) {
        throw new Error(localize("azureResourceNotFound", "Azure Resource not found"));
      } else {
        azureResourceId = azureResource.id;
      }
    }

    return azureResourceId;
  };

  protected createArmClient = async (
    azureAccountId: string,
    azureTenantId: string,
    azureResourceId: string,
    cosmosDbAccountName: string
  ): Promise<CosmosDBManagementClient> => {
    const azureAccount = await this.retrieveAzureAccount(azureAccountId);
    const armEndpoint = azureAccount.properties?.providerSettings?.settings?.armResource?.endpoint;

    if (!armEndpoint) {
      throw new Error(localize("failRetrieveArmEndpoint", "Unable to retrieve ARM endpoint"));
    }

    const azureToken = await this.retrieveAzureToken(azureTenantId, azureAccountId);
    const credentials = new TokenCredentials(azureToken.token, azureToken.tokenType /* , 'Bearer' */);

    if (!azureResourceId) {
      const azureResource = await this.retrieveResourceInfofromArm(cosmosDbAccountName, credentials);
      if (!azureResource) {
        throw new Error(localize("azureResourceNotFound", "Azure Resource not found"));
      } else {
        azureResourceId = azureResource.id;
      }
    }

    const { subscriptionId } = this.parsedAzureResourceId(azureResourceId);

    return new CosmosDBManagementClient(credentials, subscriptionId, { baseUri: armEndpoint });
  };

  protected createArmMonitorClient = async (
    azureAccountId: string,
    azureTenantId: string,
    azureResourceId: string,
    cosmosDbAccountName: string
  ): Promise<MonitorManagementClient> => {
    const azureAccount = await this.retrieveAzureAccount(azureAccountId);
    const armEndpoint = azureAccount.properties?.providerSettings?.settings?.armResource?.endpoint; // TODO Get the endpoint from the resource, not the aad account

    if (!armEndpoint) {
      throw new Error(localize("failRetrieveArmEndpoint", "Unable to retrieve ARM endpoint"));
    }

    const azureToken = await this.retrieveAzureToken(azureTenantId, azureAccountId);
    const credentials = new TokenCredentials(azureToken.token, azureToken.tokenType /* , 'Bearer' */);

    if (!azureResourceId) {
      const azureResource = await this.retrieveResourceInfofromArm(cosmosDbAccountName, credentials);
      if (!azureResource) {
        throw new Error(localize("azureResourceNotFound", "Azure Resource not found"));
      } else {
        azureResourceId = azureResource.id;
      }
    }

    const { subscriptionId } = this.parsedAzureResourceId(azureResourceId);

    return new MonitorManagementClient(credentials, subscriptionId, { baseUri: armEndpoint });
  };

  /**
   * use cosmosdb-arm to retrive connection string
   */
  public retrieveConnectionStringFromArm = async (
    azureAccountId: string,
    azureTenantId: string,
    azureResourceId: string,
    cosmosDbAccountName: string
  ): Promise<string> => {
    const client = await this.createArmClient(azureAccountId, azureTenantId, azureResourceId, cosmosDbAccountName);

    azureResourceId = await this.retrieveResourceId(
      azureAccountId,
      azureTenantId,
      azureResourceId,
      cosmosDbAccountName
    );

    // TODO: check resourceGroup here
    const { resourceGroup } = this.parsedAzureResourceId(azureResourceId);

    showStatusBarItem(localize("retrievingConnectionString", "Retrieving connection string..."));
    const connectionStringsResponse = await client.databaseAccounts.listConnectionStrings(
      resourceGroup,
      cosmosDbAccountName
    );
    hideStatusBarItem();

    if (!connectionStringsResponse.connectionStrings) {
      throw new Error(localize("noConnectionStringsFound", "No Connection strings found for this account"));
    }

    // Pick first connection string
    const connectionString = connectionStringsResponse.connectionStrings[0].connectionString;

    if (!connectionString) {
      throw new Error(localize("missingConnectionString", "Error: missing connection string"));
    }
    return connectionString;
  };

  public retrieveDatabaseAccountInfo = async (
    azureAccountId: string,
    azureTenantId: string,
    azureResourceId: string,
    cosmosDbAccountName: string
  ): Promise<ICosmosDbDatabaseAccountInfo> => {
    const client = await this.createArmClient(azureAccountId, azureTenantId, azureResourceId, cosmosDbAccountName);

    if (!azureResourceId) {
      const azureToken = await this.retrieveAzureToken(azureTenantId, azureAccountId);
      const credentials = new TokenCredentials(azureToken.token, azureToken.tokenType /* , 'Bearer' */);

      const azureResource = await this.retrieveResourceInfofromArm(cosmosDbAccountName, credentials);
      if (!azureResource) {
        throw new Error(localize("azureResourceNotFound", "Azure Resource not found"));
      } else {
        azureResourceId = azureResource.id;
      }
    }
    const { resourceGroup } = this.parsedAzureResourceId(azureResourceId);

    showStatusBarItem(localize("retrievingDatabaseAccounts", "Retrieving database accounts..."));
    const databaseAccount = await client.databaseAccounts.get(resourceGroup, cosmosDbAccountName);
    hideStatusBarItem();
    return {
      serverStatus: getServerState(databaseAccount.provisioningState),
      backupPolicy: databaseAccount.backupPolicy?.type ?? localize("none", "None"),
      consistencyPolicy: databaseAccount.consistencyPolicy?.defaultConsistencyLevel ?? localize("none", "None"),
      location: databaseAccount.location ?? localize("unknown", "Unknown"),
      readLocations: databaseAccount.readLocations
        ? databaseAccount.readLocations.map((l) => l.locationName ?? "")
        : [],
      documentEndpoint: databaseAccount.documentEndpoint,
    };
  };

  protected throughputSettingToString = (throughputSetting: ThroughputSettingsGetPropertiesResource): string => {
    if (throughputSetting.autoscaleSettings) {
      return `Max: ${throughputSetting.autoscaleSettings.maxThroughput} RU/s (autoscale)`;
    } else if (throughputSetting.throughput) {
      return `${throughputSetting.throughput} RU/s`;
    } else {
      return "";
    }
  };

  // TODO Find a better way to express this
  public getAccountName = (connectionInfo: azdata.ConnectionInfo): string => connectionInfo.options["server"];
  public getAccountNameFromOptions = (connectionOptions: IConnectionOptions): string => connectionOptions.server;

  protected retrieveResourceInfofromArm = async (
    cosmosDbAccountName: string,
    credentials: TokenCredentials
  ): Promise<{ subscriptionId: string; id: string } | undefined> => {
    const client = new ResourceGraphClient(credentials);
    const result = await client.resources(
      {
        query: `Resources | where type == "microsoft.documentdb/databaseaccounts" and name == "${cosmosDbAccountName}"`,
      },
      {
        $top: 1000,
        $skip: 0,
        $skipToken: "",
        resultFormat: "table",
      }
    );

    return result.data[0];
  };

  public abstract createDatabase(
    azureAccountId: string,
    azureTenantId: string,
    azureResourceId: string,
    cosmosDbAccountName: string,
    databaseName?: string
  ): Promise<{ databaseName: string }>;

  public abstract createDatabaseAndCollection(
    azureAccountId: string,
    azureTenantId: string,
    azureResourceId: string,
    cosmosDbAccountName: string,
    databaseName?: string,
    collectionName?: string,
    cdbCreateInfo?: CdbCollectionCreateInfo
  ): Promise<{ databaseName: string; collectionName: string | undefined }>;

  public abstract retrieveCollectionsInfo(
    azureAccountId: string,
    azureTenantId: string,
    azureResourceId: string,
    cosmosDbAccountName: string,
    databaseName: string
  ): Promise<ICosmosDbCollectionInfo[]>;

  public abstract changeCollectionThroughput(
    azureAccountId: string,
    azureTenantId: string,
    azureResourceId: string,
    cosmosDbAccountName: string,
    databaseName: string,
    collectionInfo: ICosmosDbCollectionInfo
  ): Promise<boolean>;

  public abstract retrieveDatabasesInfo(
    azureAccountId: string,
    azureTenantId: string,
    azureResourceId: string,
    cosmosDbAccountName: string,
    fetchThroughputOnly?: boolean
  ): Promise<ICosmosDbDatabaseInfo[]>;

  public abstract changeDatabaseThroughput(
    azureAccountId: string,
    azureTenantId: string,
    azureResourceId: string,
    cosmosDbAccountName: string,
    databaseInfo: ICosmosDbDatabaseInfo
  ): Promise<boolean>;
}
