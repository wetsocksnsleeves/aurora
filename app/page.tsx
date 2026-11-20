import { ShowList } from "@/components/shows/ShowList";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Aurora</h1>
      <p className={styles.subtitle}>
        Synchronised light shows on phone screens.
      </p>
      <ShowList />
    </main>
  );
}
