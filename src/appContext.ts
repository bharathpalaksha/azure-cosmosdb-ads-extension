import { Collection, MongoClient, MongoClientOptions } from "mongodb";
import * as vscode from "vscode";
import * as azdata from "azdata";
import { ProviderId } from "./Providers/connectionProvider";
import { CosmosDBManagementClient } from "@azure/arm-cosmosdb";
import { TokenCredentials } from "@azure/ms-rest-js";

// import { CosmosClient, DatabaseResponse } from '@azure/cosmos';

export interface IDatabaseInfo {
  name?: string;
  empty?: boolean;
}

type ConnectionPick = azdata.connection.ConnectionProfile & vscode.QuickPickItem;
export interface ConnectionInfo {
  connectionId: string;
  serverName: string;
}

/**
 * Global context for app
 */
export class AppContext {
  public static readonly CONNECTION_INFO_KEY_PROP = "server"; // Unique key to store connection info against
  private _mongoClients = new Map<string, MongoClient>();

  public async connect(server: string, connectionString: string): Promise<MongoClient | undefined> {
    const options: MongoClientOptions = <MongoClientOptions>{};
    try {
      const mongoClient = await MongoClient.connect(connectionString, options);
      this._mongoClients.set(server, mongoClient);
      return mongoClient;
    } catch (error) {
      console.error(error);
      return undefined;
    }
  }

  public async listDatabases(server: string): Promise<IDatabaseInfo[]> {
    if (!this._mongoClients.has(server)) {
      return [];
    }
    // https://mongodb.github.io/node-mongodb-native/3.1/api/index.html
    const result: { databases: IDatabaseInfo[] } = await this._mongoClients
      .get(server)!
      .db("test" /*testDb*/)
      .admin()
      .listDatabases();
    return result.databases;
  }

  public async listCollections(server: string, databaseName: string): Promise<Collection[]> {
    if (!this._mongoClients.has(server)) {
      return [];
    }
    return await this._mongoClients.get(server)!.db(databaseName).collections();
  }

  public async removeDatabase(server: string, databaseName: string): Promise<boolean> {
    if (!this._mongoClients.has(server)) {
      return false;
    }
    return await this._mongoClients.get(server)!.db(databaseName).dropDatabase();
  }

  public async removeCollection(server: string, databaseName: string, collectionName: string): Promise<boolean> {
    if (!this._mongoClients.has(server)) {
      return false;
    }
    return await this._mongoClients.get(server)!.db(databaseName).dropCollection(collectionName);
  }

  private async _askUserForConnectionProfile(): Promise<ConnectionPick | undefined> {
    const connections = await azdata.connection.getConnections();
    const picks: ConnectionPick[] = connections
      .filter((c) => c.providerId === ProviderId)
      .map((c) => ({
        ...c,
        label: c.connectionName,
      }));

    return vscode.window.showQuickPick<ConnectionPick>(picks, {
      placeHolder: "Select mongo account",
    });
  }

  public createMongoCollection(connectionInfo?: ConnectionInfo, databaseName?: string): Promise<Collection> {
    return new Promise(async (resolve, reject) => {
      if (!connectionInfo) {
        const connectionProfile = await this._askUserForConnectionProfile();
        if (!connectionProfile) {
          // TODO Show error here
          reject("Missing connectionProfile");
          return;
        }

        connectionInfo = {
          connectionId: connectionProfile.connectionId,
          serverName: connectionProfile.serverName,
        };
      }

      if (!databaseName) {
        databaseName = await vscode.window.showInputBox({
          placeHolder: "Database",
          prompt: "Enter database name",
          validateInput: validateMongoDatabaseName,
          ignoreFocusOut: true,
        });
      }

      const collectionName = await vscode.window.showInputBox({
        placeHolder: "Collection",
        prompt: "Enter collection name",
        validateInput: validateMongoCollectionName,
        ignoreFocusOut: true,
      });

      if (!collectionName) {
        // TODO handle error
        reject("Collection cannot be undefined");
        return;
      }

      const credentials = await azdata.connection.getCredentials(connectionInfo.connectionId);

      const server = connectionInfo.serverName;

      if (!server || !credentials || !credentials["password"]) {
        reject(`Missing serverName or connectionId ${server} ${credentials}`);
      }

      const connectionString = credentials["password"];

      const client = await this.connect(server, connectionString);

      if (client) {
        const collection = await client.db(databaseName).createCollection(collectionName);
        resolve(collection);
      } else {
        reject(`Could not connect to ${server}`);
      }
    });
  }

  public disconnect(server: string): Promise<void> {
    if (!this._mongoClients.has(server)) {
      return Promise.resolve();
    }

    const client = this._mongoClients.get(server);
    this._mongoClients.delete(server);
    return client!.close();
  }
}

export function validateMongoCollectionName(collectionName: string): string | undefined | null {
  // https://docs.mongodb.com/manual/reference/limits/#Restriction-on-Collection-Names
  if (!collectionName) {
    return "Collection name cannot be empty";
  }
  const systemPrefix = "system.";
  if (collectionName.startsWith(systemPrefix)) {
    return `"${systemPrefix}" prefix is reserved for internal use`;
  }
  if (/[$]/.test(collectionName)) {
    return "Collection name cannot contain $";
  }
  return undefined;
}

function validateMongoDatabaseName(database: string): string | undefined | null {
  // https://docs.mongodb.com/manual/reference/limits/#naming-restrictions
  // "#?" are restricted characters for CosmosDB - MongoDB accounts
  const min = 1;
  const max = 63;
  if (!database || database.length < min || database.length > max) {
    return `Database name must be between ${min} and ${max} characters.`;
  }
  if (/[/\\. "$#?]/.test(database)) {
    return 'Database name cannot contain these characters - `/\\. "$#?`';
  }
  return undefined;
}

/**
 * use cosmosdb-arm to retrive connection string
 */
export const retrieveConnectionStringFromArm = async (connectionInfoOptions: {
  [name: string]: any;
}): Promise<string> => {
  const cosmosDbAccountName = connectionInfoOptions["server"];
  const tenantId = connectionInfoOptions["azureTenantId"];
  const accountId = connectionInfoOptions["azureAccount"];
  const accounts = (await azdata.accounts.getAllAccounts()).filter((a) => a.key.accountId === accountId);
  if (accounts.length < 1) {
    throw new Error("No azure account found");
  }

  const azureAccount = accounts[0];

  const azureToken = await azdata.accounts.getAccountSecurityToken(
    azureAccount,
    tenantId,
    azdata.AzureResource.ResourceManagement
  );

  if (!azureToken) {
    throw new Error("Unable to retrieve ARM token");
  }

  const armEndpoint = azureAccount.properties?.providerSettings?.settings?.armResource?.endpoint;

  if (!armEndpoint) {
    throw new Error("Unable to retrieve ARM endpoint");
  }

  const parsedAzureResourceId = connectionInfoOptions["azureResourceId"].split("/");
  const subscriptionId = parsedAzureResourceId[2];
  const resourceGroup = parsedAzureResourceId[4];
  const client = createAzureClient(
    subscriptionId,
    new TokenCredentials(azureToken.token, azureToken.tokenType /* , 'Bearer' */),
    armEndpoint
  );

  const connectionStringsResponse = await client.databaseAccounts.listConnectionStrings(
    resourceGroup,
    cosmosDbAccountName
  );
  const connectionString = connectionStringsResponse.connectionStrings?.[0]?.connectionString;
  if (!connectionString) {
    throw new Error("Missing connection string");
  }
  return connectionString;
};

const createAzureClient = (
  subscriptionId: string,
  credentials: any /*msRest.ServiceClientCredentials */,
  armEndpoint: string
) => {
  return new CosmosDBManagementClient(credentials, subscriptionId, { baseUri: armEndpoint });
};
