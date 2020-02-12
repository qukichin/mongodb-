import * as mongo from "./mongo";
import * as k8s from "./k8s";
import * as config from "./config";
import * as ip from "ip";
import * as async from "async";
import * as moment from "moment";
import * as dns from "dns";
import * as os from "os";


var loopSleepSeconds = config.loopSleepSeconds;
var unhealthySeconds = config.unhealthySeconds;

var hostIp = false;
var hostIpAndPort = false;


const init = done => {
  let hostName = os.hostname();
  dns.lookup(
    hostName,
    (err, addr) => {
      if (err)
        return done(err);

      hostIp = addr;
      hostIpAndPort = hostIp + ':' + config.mongoPort;

      done();
    }
  );
};


const workloop = () => {
  if (!hostIp || !hostIpAndPort)
    throw new Error('Must initialize with the host machine\'s addr');

  // Do in series so if k8s.getMongoPods fails, it doesn't open a db connection
  async.series([
    k8s.getMongoPods,
    mongo.getDb
  ], (err, results) => {
    let db = null;
    if (Array.isArray(results) && results.length === 2) {
      db = results[1];
    }

    if (err)
      return finish(err, db);

    let pods = results[0];

    //Lets remove any pods that aren't running or haven't been assigned an IP address yet
    for (let i = pods.length - 1; i >= 0; i--) {
      let pod = pods[i];
      if (pod.status.phase !== 'Running' || !pod.status.podIP)
        pods.splice(i, 1);
    }

    if (!pods.length)
      return finish('No pods are currently running, probably just give them some time.');

    mongo.replSetGetStatus(db, function (err, status) {
      if (err) {
        if (err.code && err.code == 94) {
          notInReplicaSet(db, pods, function (err) {
            finish(err, db);
          });
        }
        else if (err.code && err.code == 93) {
          invalidReplicaSet(db, pods, status, function (err) {
            finish(err, db);
          });
        }
        else {
          finish(err, db);
        }
        return;
      }

      inReplicaSet(
        db,
        pods,
        status,
        err => finish(err, db)
      );
    });
  });
};


const finish = (err, db) => {
  if (err)
    console.error('Error in workloop', err);

  if (db && db.close)
    db.close();

  setTimeout(workloop, loopSleepSeconds * 1000);
};


const inReplicaSet = (db, pods, status, done) => {
  // If we're already in a rs and we ARE the primary, do the work of the primary instance (i.e. adding others)
  // If we're already in a rs and we ARE NOT the primary, just continue, nothing to do
  // If we're already in a rs and NO ONE is a primary, elect someone to do the work for a primary
  let members = status.members;

  let primaryExists = false;
  for (let i in members) {
    let member = members[i];

    if (member.state === 1) {
      if (member.self) {
        return primaryWork(db, pods, members, false, done);
      }

      primaryExists = true;
      break;
    }
  }

  if (!primaryExists && podElection(pods)) {
    console.log('Pod has been elected as a secondary to do primary work');
    return primaryWork(db, pods, members, true, done);
  }

  done();
};


const primaryWork = (db, pods, members, shouldForce, done) => {
  // 迭代当前 Pods，如果有 Pod 未在 members 数组中，那么就将其添加进来
  let addrToAdd = addrToAddLoop(pods, members);
  let addrToRemove = addrToRemoveLoop(members);

  if (addrToAdd.length || addrToRemove.length) {
    console.log('Addresses to add:    ', addrToAdd);
    console.log('Addresses to remove: ', addrToRemove);

    mongo.addNewReplSetMembers(db, addrToAdd, addrToRemove, shouldForce, done);
    return;
  }

  done();
};


const notInReplicaSet = (db, pods, done) => {

  const createTestRequest = pod => completed => mongo.isInReplSet(pod.status.podIP, completed);

  let testRequests = [];
  for (let i in pods) {
    let pod = pods[i];
    if (pod.status.phase === 'Running')
      testRequests.push(createTestRequest(pod));
  }

  async.parallel(testRequests, (err, results) => {
    if (err)
      return done(err);

    for (let i in results) {
      if (results[i])
        return done();
    }

    if (podElection(pods)) {
      console.log('Pod has been elected for replica set initialization');

      let primary = pods[0]; // After the sort election, the 0-th pod should be the primary.
      let primaryStableNetworkAddressAndPort = getPodStableNetworkAddressAndPort(primary);
      let primaryAddressAndPort = primaryStableNetworkAddressAndPort || hostIpAndPort;

      mongo.initReplSet(db, primaryAddressAndPort, done);

      return;
    }

    done();
  });
};


const invalidReplicaSet = (db, pods, status, done) => {
  let members = [];
  if (status && status.members) {
    members = status.members;
  }

  console.log("Invalid replica set");
  if (!podElection(pods)) {
    console.log("Didn't win the pod election, doing nothing");
    return done();
  }

  console.log("Won the pod election, forcing re-initialization");
  let addrToAdd = addrToAddLoop(pods, members);
  let addrToRemove = addrToRemoveLoop(members);

  mongo.addNewReplSetMembers(db, addrToAdd, addrToRemove, true, err => done(err));
};


const podElection = pods => {
  // Because all the pods are going to be running this code independently, we need a way to consistently find the same
  // node to kick things off, the easiest way to do that is convert their ips into longs and find the highest

  pods.sort((a, b) => {
    var aIpVal = ip.toLong(a.status.podIP);
    var bIpVal = ip.toLong(b.status.podIP);
    if (aIpVal < bIpVal) return -1;
    if (aIpVal > bIpVal) return 1;
    return 0; // Shouldn't get here... all pods should have different ips
  });

  return pods[0].status.podIP == hostIp;
};


const addrToAddLoop = (pods, members) => {
  let addrToAdd = [];
  for (let i in pods) {
    let pod = pods[i];
    if (pod.status.phase !== 'Running')
      continue;

    let podIpAddr = getPodIpAddressAndPort(pod);
    let podStableNetworkAddr = getPodStableNetworkAddressAndPort(pod);
    let podInRs = false;

    for (let j in members) {
      let member = members[j];
      if (member.name === podIpAddr || member.name === podStableNetworkAddr) {
        podInRs = true;
        break;
      }
    }

    if (!podInRs) {
      // If the node was not present, we prefer the stable network ID, if present.
      let addrToUse = podStableNetworkAddr || podIpAddr;
      addrToAdd.push(addrToUse);
    }
  }
  return addrToAdd;
};


const addrToRemoveLoop = members => {
  let addrToRemove = [];
  for (let i in members) {
    let member = members[i];
    if (memberShouldBeRemoved(member))
      addrToRemove.push(member.name);
  }
  return addrToRemove;
};


const memberShouldBeRemoved = member => !member.health && moment().subtract(unhealthySeconds, 'seconds').isAfter(member.lastHeartbeatRecv);

/**
 * @param pod this is the Kubernetes pod, containing the info.
 * @returns string - podIp the pod's IP address with the port from config attached at the end. Example
 * WWW.XXX.YYY.ZZZ:27017. It returns undefined, if the data is insufficient to retrieve the IP address.
 */
const getPodIpAddressAndPort = pod => (!pod || !pod.status || !pod.status.podIP) ? undefined : pod.status.podIP + ":" + config.mongoPort;


/**
 * Gets the pod's address. It can be either in the form of
 * '<pod-name>.<mongo-kubernetes-service>.<pod-namespace>.svc.cluster.local:<mongo-port>'. See:
 * <a href="https://kubernetes.io/docs/concepts/abstractions/controllers/statefulsets/#stable-network-id">Stateful Set documentation</a>
 * for more details. If those are not set, then simply the pod's IP is returned.
 * @param pod the Kubernetes pod, containing the information from the k8s client.
 * @returns string the k8s MongoDB stable network address, or undefined.
 */
const getPodStableNetworkAddressAndPort = pod => {
  if (!config.k8sMongoServiceName || !pod || !pod.metadata || !pod.metadata.name || !pod.metadata.namespace) return;
  let clusterDomain = config.k8sClusterDomain, mongoPort = config.mongoPort;
  return pod.metadata.name + "." + config.k8sMongoServiceName + "." + pod.metadata.namespace + ".svc." + clusterDomain + ":" + mongoPort;
};

export { init, workloop }
