import { collection, addDoc, getDocs, doc, deleteDoc, serverTimestamp, setDoc, updateDoc, getDoc } from "firebase/firestore";
import { db } from "./firebase";

const wpSitesCollection = collection(db, "wpSites");

export async function getAllSites() {
  const snapshot = await getDocs(wpSitesCollection);
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function addSiteToFirebase(domain: string, initialData: any) {
  const docRef = await addDoc(wpSitesCollection, {
    domain,
    lastChecked: serverTimestamp(),
    lastData: initialData || { core: { current: "?.?" }, plugins: [] },
    ok: !!initialData,
    status: initialData ? "online" : "offline"
  });
  return docRef.id;
}

export async function deleteSiteFromFirebase(id: string) {
  await deleteDoc(doc(db, "wpSites", id));
}

export async function updateSiteInFirebase(id: string, data: any) {
  // Sla altijd op als er data is, ongeacht welke velden aanwezig zijn
  if (data) {
    const existing = await getDoc(doc(db, "wpSites", id));
    const domain = existing.data()?.domain || "";
    await setDoc(doc(db, "wpSites", id), {
      domain,
      lastChecked: serverTimestamp(),
      lastData: data,
      ok: true,
      status: "online"
    });
  } else {
    await updateDoc(doc(db, "wpSites", id), {
      lastChecked: serverTimestamp(),
      ok: false,
      status: "offline"
    });
  }
}