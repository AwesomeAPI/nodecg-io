import { NodeCG } from "nodecg/types/server";
import { ServiceManager } from "./serviceManager";
import { BundleManager } from "./bundleManager";
import { MessageManager } from "./messageManager";
import { InstanceManager } from "./instanceManager";
import { Service, ServiceClient } from "./types";
import { PersistenceManager } from "./persistenceManager";
import { ServiceClientWrapper } from "./serviceClientWrapper";

/**
 * Main type of NodeCG extension that the core bundle exposes.
 * Contains references to all internal modules.
 */
export interface NodeCGIOCore {
    registerService<R, C extends ServiceClient<unknown>>(service: Service<R, C>): void;
    requireService<C extends ServiceClient<unknown>>(
        nodecg: NodeCG,
        serviceType: string,
    ): ServiceClientWrapper<C> | undefined;
}

module.exports = (nodecg: NodeCG): NodeCGIOCore => {
    nodecg.log.info("Minzig!");

    const serviceManager = new ServiceManager(nodecg);
    const bundleManager = new BundleManager(nodecg);
    const instanceManager = new InstanceManager(nodecg, serviceManager, bundleManager);
    const persistenceManager = new PersistenceManager(nodecg, instanceManager, bundleManager);

    new MessageManager(
        nodecg,
        serviceManager,
        instanceManager,
        bundleManager,
        persistenceManager,
    ).registerMessageHandlers();

    registerExitHandlers(nodecg, bundleManager, instanceManager, serviceManager);

    // We use a extra object instead of returning a object containing all the managers and so on, because
    // any loaded bundle would be able to call any (public or private) of the managers which is not intended.
    return {
        registerService<R, C extends ServiceClient<unknown>>(service: Service<R, C>): void {
            serviceManager.registerService(service);
        },
        requireService<C extends ServiceClient<unknown>>(
            nodecg: NodeCG,
            serviceType: string,
        ): ServiceClientWrapper<C> | undefined {
            const bundleName = nodecg.bundleName;
            const svc = serviceManager.getService(serviceType);

            if (svc.failed) {
                nodecg.log.warn(
                    `The bundle "${bundleName}" can't require the "${serviceType}" service: ` +
                        "no service with such name.",
                );
                return;
            }

            const wrapper = new ServiceClientWrapper<C>();
            bundleManager.registerServiceDependency(bundleName, svc.result as Service<unknown, C>, (client) => {
                wrapper.emit("update", client);
            });

            return wrapper;
        },
    };
};

function onExit(
    nodecg: NodeCG,
    bundleManager: BundleManager,
    instanceManager: InstanceManager,
    serviceManager: ServiceManager,
): void {
    // Unset all service instances in all bundles
    const bundles = bundleManager.getBundleDependencies();
    for (const bundleName in bundles) {
        bundles[bundleName]?.forEach((bundleDependency) => {
            // Only unset a service instance if it was set previously
            if (bundleDependency.serviceInstance !== undefined) {
                bundleDependency.clientUpdateCallback(undefined);
            }
        });
    }

    // Call `stopClient` for all service instances
    const instances = instanceManager.getServiceInstances();
    for (const key in instances) {
        if (instances[key] !== undefined) {
            const client = instances[key]?.client;
            const service = serviceManager.getService(instances[key]?.serviceType as string);
            if (!service.failed) {
                nodecg.log.info(`Stopping service ${key} of type ${service.result.serviceType}.`);
                try {
                    service.result.stopClient(client);
                } catch (err) {
                    nodecg.log.info(
                        `Could not stop service ${key} of type ${service.result.serviceType}: ${String(err)}`,
                    );
                }
            }
        }
    }
}

function registerExitHandlers(
    nodecg: NodeCG,
    bundleManager: BundleManager,
    instanceManager: InstanceManager,
    serviceManager: ServiceManager,
): void {
    const handler = () => {
        onExit(nodecg, bundleManager, instanceManager, serviceManager);
    };

    // Normal exit
    process.on("exit", handler);
    // Ctrl + C
    process.on("SIGINT", handler);
    // kill
    process.on("SIGTERM", handler);
    // nodemon
    process.once("SIGUSR1", () => {
        handler();
        process.kill(process.pid, "SIGUSR1");
    });
    process.once("SIGUSR2", () => {
        handler();
        process.kill(process.pid, "SIGUSR2");
    });
    // Uncaught exception
    process.on("uncaughtException", handler);
    process.on("unhandledRejection", handler);
}
